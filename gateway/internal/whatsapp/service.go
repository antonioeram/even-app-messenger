package whatsapp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	wastore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite" // registers the "sqlite" driver

	"github.com/antonioeram/even-app-messenger/gateway/internal/store"
)

// Session states reported to the admin page.
const (
	StateStarting       = "starting"
	StatePairing        = "pairing"
	StatePairingExpired = "pairing_expired"
	StateConnected      = "connected"
	StateDisconnected   = "disconnected"
	StateLoggedOut      = "logged_out"
)

// pairingWindow bounds how long the gateway keeps asking WhatsApp for fresh
// pairing codes after a start without a session.
const pairingWindow = 20 * time.Minute

// Status is a snapshot of the session for the admin page.
type Status struct {
	State   string
	QR      string
	Account string
}

// Service owns the WhatsApp session.
type Service struct {
	cli   *whatsmeow.Client
	db    *sql.DB
	store *store.Store
	log   *slog.Logger

	mu         sync.Mutex
	state      string
	qr         string
	groupNames map[types.JID]string

	syncingNames atomic.Bool
	// runCtx is the context given to Start; pairing restarts run under it.
	runCtx context.Context
}

// Open prepares the session stored at sessionPath (created when missing).
// It does not connect; call Start.
func Open(ctx context.Context, sessionPath string, st *store.Store, logger *slog.Logger) (*Service, error) {
	dsn := "file:" + (&url.URL{Path: sessionPath}).EscapedPath() +
		"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open whatsapp session: %w", err)
	}
	wl := slogLogger{log: logger}
	container := sqlstore.NewWithDB(db, "sqlite3", wl.Sub("store"))
	if err := container.Upgrade(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("prepare whatsapp session: %w", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("load whatsapp device: %w", err)
	}
	// The name the phone shows under Linked devices.
	wastore.DeviceProps.Os = proto.String("Even Messenger")

	s := &Service{
		cli:        whatsmeow.NewClient(device, wl.Sub("client")),
		db:         db,
		store:      st,
		log:        logger,
		state:      StateStarting,
		groupNames: map[types.JID]string{},
	}
	s.cli.AddEventHandler(s.handle)
	return s, nil
}

// Start connects in the background and returns at once.
func (s *Service) Start(ctx context.Context) {
	s.runCtx = ctx
	go s.run(ctx)
}

// Pair asks WhatsApp for fresh pairing codes. It does something only after
// the previous codes expired without a scan.
func (s *Service) Pair() {
	s.mu.Lock()
	expired := s.state == StatePairingExpired
	if expired {
		s.state = StateStarting
	}
	s.mu.Unlock()
	if expired && s.runCtx != nil {
		go s.run(s.runCtx)
	}
}

// Close disconnects and releases the session database.
func (s *Service) Close() {
	s.cli.Disconnect()
	_ = s.db.Close()
}

// Status returns the current session state.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{State: s.state, QR: s.qr}
	if id := s.cli.Store.ID; id != nil {
		st.Account = "+" + id.User
	}
	return st
}

func (s *Service) setState(state, qr string) {
	s.mu.Lock()
	changed := s.state != state
	s.state, s.qr = state, qr
	s.mu.Unlock()
	if changed {
		s.log.Info("whatsapp state", "state", state)
	}
}

func (s *Service) run(ctx context.Context) {
	if s.cli.Store.ID != nil {
		s.setState(StateDisconnected, "")
		for ctx.Err() == nil {
			err := s.cli.Connect()
			if err == nil {
				return // whatsmeow reconnects on its own from here on
			}
			s.log.Warn("whatsapp connect failed", "error", err)
			sleep(ctx, 30*time.Second)
		}
		return
	}

	deadline := time.Now().Add(pairingWindow)
	for ctx.Err() == nil && time.Now().Before(deadline) {
		codes, err := s.cli.GetQRChannel(ctx)
		if err != nil {
			s.log.Warn("whatsapp pairing could not start", "error", err)
			return
		}
		if err := s.cli.Connect(); err != nil {
			s.log.Warn("whatsapp connect failed", "error", err)
			sleep(ctx, 10*time.Second)
			continue
		}
		paired := false
		for item := range codes {
			switch item.Event {
			case "code":
				// The code links a device to the account: it is never logged.
				s.setState(StatePairing, item.Code)
			case "success":
				paired = true
			default:
				s.log.Info("whatsapp pairing", "event", item.Event)
			}
		}
		if paired {
			return // the Connected event sets the state
		}
		s.cli.Disconnect()
		sleep(ctx, 3*time.Second)
	}
	if ctx.Err() == nil {
		s.setState(StatePairingExpired, "")
	}
}

func (s *Service) handle(evt any) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	switch v := evt.(type) {
	case *events.Message:
		s.saveMessage(ctx, v, true, nil)
	case *events.HistorySync:
		go s.saveHistory(v)
	case *events.Connected:
		s.setState(StateConnected, "")
		go s.syncContactNames()
	case *events.AppStateSyncComplete:
		go s.syncContactNames()
	case *events.Disconnected, *events.StreamReplaced:
		if s.Status().State != StateLoggedOut {
			s.setState(StateDisconnected, "")
		}
	case *events.LoggedOut:
		s.setState(StateLoggedOut, "")
	case *events.MarkChatAsRead:
		if v.Action.GetRead() {
			s.warn("mark chat read", s.store.SetUnread(ctx, s.canonical(ctx, v.JID, types.EmptyJID).String(), 0))
		}
	case *events.Receipt:
		// Read on the phone or on another linked device.
		if v.Type == types.ReceiptTypeReadSelf {
			s.warn("mark chat read", s.store.SetUnread(ctx, s.canonical(ctx, v.Chat, types.EmptyJID).String(), 0))
		}
	case *events.Contact:
		if name := bestName(types.ContactInfo{FullName: v.Action.GetFullName(), FirstName: v.Action.GetFirstName()}, ""); name != "" {
			s.warn("store contact name", s.store.UpsertChat(ctx, store.Chat{ID: s.canonical(ctx, v.JID, types.EmptyJID).String(), Name: name}))
		}
	case *events.PushName:
		jid := s.canonical(ctx, v.JID, v.JIDAlt)
		if name := s.contactName(ctx, jid, v.NewPushName); name != "" {
			s.warn("store push name", s.store.UpsertChat(ctx, store.Chat{ID: jid.String(), Name: name}))
		}
	}
}

// saveMessage stores one message. live is false for history, which must not
// change unread counters. chat overrides the chat address when the caller
// already resolved it.
func (s *Service) saveMessage(ctx context.Context, evt *events.Message, live bool, chat *types.JID) {
	info := evt.Info
	if skipChat(info.Chat) || evt.IsEdit {
		return
	}
	text, kind, ok := messageText(evt.Message)
	if !ok {
		return
	}
	group := info.Chat.Server == types.GroupServer
	chatJID := info.Chat.ToNonAD()
	switch {
	case chat != nil:
		chatJID = *chat
	case !group:
		alt := info.SenderAlt
		if info.IsFromMe {
			alt = info.RecipientAlt
		}
		chatJID = s.canonical(ctx, info.Chat, alt)
	}

	sender, senderID := "", ""
	if !info.IsFromMe {
		senderJID := s.canonical(ctx, info.Sender, info.SenderAlt)
		senderID = senderJID.String()
		if sender = s.contactName(ctx, senderJID, info.PushName); sender == "" {
			sender = "+" + senderJID.User
		}
	}
	chatName := ""
	switch {
	case group:
		chatName = s.groupName(ctx, chatJID, live)
	case info.IsFromMe:
		chatName = s.contactName(ctx, chatJID, "")
	default:
		chatName = s.contactName(ctx, chatJID, info.PushName)
	}

	id := chatJID.String()
	if err := s.store.UpsertChat(ctx, store.Chat{ID: id, Name: chatName, Group: group}); err != nil {
		s.warn("store chat", err)
		return
	}
	isNew, err := s.store.SaveMessage(ctx, store.Message{
		ChatID: id, ID: info.ID, Sender: sender, SenderID: senderID, FromMe: info.IsFromMe, Time: info.Timestamp, Text: text, Kind: kind,
	})
	if err != nil {
		s.warn("store message", err)
		return
	}
	if !live || !isNew {
		return
	}
	if info.IsFromMe {
		// Answering from another device means the chat was read there.
		s.warn("reset unread", s.store.SetUnread(ctx, id, 0))
	} else {
		s.warn("count unread", s.store.AddUnread(ctx, id, 1))
	}
}

// Send delivers a text message to a chat and records it in the store.
func (s *Service) Send(ctx context.Context, chatID, text string) error {
	if s.Status().State != StateConnected {
		return errors.New("WhatsApp is not connected")
	}
	to, err := types.ParseJID(chatID)
	if err != nil || to.User == "" {
		return fmt.Errorf("invalid chat address %q", chatID)
	}
	resp, err := s.cli.SendMessage(ctx, to, &waE2E.Message{Conversation: proto.String(text)})
	if err != nil {
		return err
	}
	if _, err := s.store.SaveMessage(ctx, store.Message{
		ChatID: chatID, ID: resp.ID, FromMe: true, Time: resp.Timestamp, Text: text, Kind: "text",
	}); err != nil {
		s.warn("store sent message", err)
	}
	s.warn("reset unread", s.store.SetUnread(ctx, chatID, 0))
	return nil
}

func (s *Service) saveHistory(sync *events.HistorySync) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conversations := sync.Data.GetConversations()
	saved := 0
	for _, conv := range conversations {
		jid, err := types.ParseJID(conv.GetID())
		if err != nil || skipChat(jid) {
			continue
		}
		group := jid.Server == types.GroupServer
		chat := jid.ToNonAD()
		name := conv.GetName()
		if !group {
			pn, _ := types.ParseJID(conv.GetPnJID())
			chat = s.canonical(ctx, jid, pn)
			if known := s.contactName(ctx, chat, ""); known != "" {
				name = known
			}
		}
		if name == "" {
			name = conv.GetDisplayName()
		}
		id := chat.String()
		s.warn("store chat", s.store.UpsertChat(ctx, store.Chat{ID: id, Name: name, Group: group}))
		for _, item := range conv.GetMessages() {
			evt, err := s.cli.ParseWebMessage(jid, item.GetMessage())
			if err != nil {
				continue
			}
			s.saveMessage(ctx, evt, false, &chat)
			saved++
		}
		s.warn("store unread", s.store.SetUnread(ctx, id, int(min(conv.GetUnreadCount(), 999))))
	}
	s.log.Info("whatsapp history stored", "type", sync.Data.GetSyncType().String(), "chats", len(conversations), "messages", saved)
}

// syncContactNames copies address book names onto chats, so a chat that was
// stored before its contact arrived gets its name.
func (s *Service) syncContactNames() {
	if !s.syncingNames.CompareAndSwap(false, true) {
		return
	}
	defer s.syncingNames.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	contacts, err := s.cli.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		s.warn("read contacts", err)
		return
	}
	for jid, info := range contacts {
		if name := bestName(info, ""); name != "" {
			s.warn("store contact name", s.store.UpsertChat(ctx, store.Chat{ID: s.canonical(ctx, jid, types.EmptyJID).String(), Name: name}))
		}
	}
}

// canonical returns the address a person is stored under. WhatsApp uses two
// addresses for one person (phone number and hidden "lid"); the phone number
// is preferred so a chat does not show up twice.
func (s *Service) canonical(ctx context.Context, jid, alt types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server != types.HiddenUserServer {
		return jid
	}
	if alt.Server == types.DefaultUserServer && alt.User != "" {
		return alt.ToNonAD()
	}
	if pn, err := s.cli.Store.LIDs.GetPNForLID(ctx, jid); err == nil && pn.User != "" {
		return pn.ToNonAD()
	}
	return jid
}

func (s *Service) contactName(ctx context.Context, jid types.JID, pushName string) string {
	contact, err := s.cli.Store.Contacts.GetContact(ctx, jid)
	if err != nil {
		return bestName(types.ContactInfo{}, pushName)
	}
	return bestName(contact, pushName)
}

// groupName returns the subject of a group. It asks WhatsApp at most once
// per group and run, and only for live messages: history carries the names.
func (s *Service) groupName(ctx context.Context, group types.JID, fetch bool) string {
	s.mu.Lock()
	name, cached := s.groupNames[group]
	s.mu.Unlock()
	if cached {
		return name
	}
	if chat, found, err := s.store.Chat(ctx, group.String()); err == nil && found && chat.Name != "" {
		name = chat.Name
	} else if fetch {
		lookup, cancel := context.WithTimeout(ctx, 15*time.Second)
		info, err := s.cli.GetGroupInfo(lookup, group)
		cancel()
		if err == nil && info != nil {
			name = info.Name
		}
	} else {
		return ""
	}
	s.mu.Lock()
	s.groupNames[group] = name
	s.mu.Unlock()
	return name
}

func (s *Service) warn(what string, err error) {
	if err != nil {
		s.log.Warn("whatsapp: "+what+" failed", "error", err)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// slogLogger forwards whatsmeow warnings and errors to the gateway log.
// Info and debug lines are dropped: they are noisy and may carry addresses.
type slogLogger struct {
	log    *slog.Logger
	module string
}

func (l slogLogger) Warnf(msg string, args ...any) {
	l.log.Warn("whatsmeow: "+fmt.Sprintf(msg, args...), "module", l.module)
}
func (l slogLogger) Errorf(msg string, args ...any) {
	l.log.Error("whatsmeow: "+fmt.Sprintf(msg, args...), "module", l.module)
}
func (l slogLogger) Infof(string, ...any)  {}
func (l slogLogger) Debugf(string, ...any) {}
func (l slogLogger) Sub(module string) waLog.Logger {
	if l.module != "" {
		module = l.module + "/" + module
	}
	return slogLogger{log: l.log, module: module}
}
