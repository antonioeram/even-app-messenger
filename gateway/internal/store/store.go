// Package store keeps chats and messages in a SQLite database.
//
// It is the gateway's own copy of what the connectors (WhatsApp, later
// email) receive; the API reads only from here.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"time"

	_ "modernc.org/sqlite" // pure Go driver: the image is built with CGO disabled
)

// Chat is one conversation as the inbox shows it.
type Chat struct {
	ID       string
	Name     string
	Group    bool
	Unread   int
	LastTime time.Time
	// Preview is the text of the newest message.
	Preview string
}

// Message is one stored message.
type Message struct {
	ChatID string
	ID     string
	// Sender is the display name of the author.
	Sender string
	FromMe bool
	Time   time.Time
	Text   string
	// Kind is "text" or the media type the text stands in for.
	Kind string
}

// Store is a handle on the message database.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS chats (
	id       TEXT PRIMARY KEY,
	name     TEXT NOT NULL DEFAULT '',
	is_group INTEGER NOT NULL DEFAULT 0,
	unread   INTEGER NOT NULL DEFAULT 0,
	last_ts  INTEGER NOT NULL DEFAULT 0,
	preview  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
	chat_id TEXT NOT NULL,
	id      TEXT NOT NULL,
	sender  TEXT NOT NULL DEFAULT '',
	from_me INTEGER NOT NULL DEFAULT 0,
	ts      INTEGER NOT NULL,
	text    TEXT NOT NULL DEFAULT '',
	kind    TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS messages_by_time ON messages (chat_id, ts);
`

// Open opens (and creates, if needed) the database at path.
func Open(ctx context.Context, path string) (*Store, error) {
	dsn := "file:" + (&url.URL{Path: path}).EscapedPath() +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open message store: %w", err)
	}
	// One connection keeps writes serialised and avoids SQLITE_BUSY between goroutines.
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create message store schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// UpsertChat creates the chat or updates its name and group flag.
// An empty name never replaces a known one.
func (s *Store) UpsertChat(ctx context.Context, c Chat) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO chats (id, name, is_group) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
			is_group = MAX(chats.is_group, excluded.is_group)`,
		c.ID, c.Name, boolInt(c.Group))
	return err
}

// SaveMessage stores m and reports whether it was not stored before.
// The chat is created when missing, and its preview follows the newest message.
func (s *Store) SaveMessage(ctx context.Context, m Message) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	ts := m.Time.UnixMilli()
	res, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO messages (chat_id, id, sender, from_me, ts, text, kind)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		m.ChatID, m.ID, m.Sender, boolInt(m.FromMe), ts, m.Text, m.Kind)
	if err != nil {
		return false, err
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO chats (id) VALUES (?)`, m.ChatID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE chats SET last_ts = ?, preview = ? WHERE id = ? AND last_ts <= ?`,
		ts, m.Text, m.ChatID, ts); err != nil {
		return false, err
	}
	return inserted > 0, tx.Commit()
}

// SetUnread sets the unread counter of a chat.
func (s *Store) SetUnread(ctx context.Context, chatID string, unread int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE chats SET unread = ? WHERE id = ?`, unread, chatID)
	return err
}

// AddUnread adds delta to the unread counter of a chat.
func (s *Store) AddUnread(ctx context.Context, chatID string, delta int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE chats SET unread = MAX(0, unread + ?) WHERE id = ?`, delta, chatID)
	return err
}

const chatColumns = `id, name, is_group, unread, last_ts, preview`

// Chats lists chats that have messages: unread ones first, then newest first.
func (s *Store) Chats(ctx context.Context, limit int) ([]Chat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+chatColumns+` FROM chats WHERE last_ts > 0
		ORDER BY (unread > 0) DESC, last_ts DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var chats []Chat
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		chats = append(chats, c)
	}
	return chats, rows.Err()
}

// Chat returns one chat; ok is false when it does not exist.
func (s *Store) Chat(ctx context.Context, id string) (c Chat, ok bool, err error) {
	c, err = scanChat(s.db.QueryRowContext(ctx, `SELECT `+chatColumns+` FROM chats WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Chat{}, false, nil
	}
	return c, err == nil, err
}

// Messages returns up to limit messages of a chat, oldest first. With a zero
// before it returns the newest ones; otherwise the ones older than before.
func (s *Store) Messages(ctx context.Context, chatID string, limit int, before time.Time) ([]Message, error) {
	cutoff := int64(1<<62 - 1)
	if !before.IsZero() {
		cutoff = before.UnixMilli()
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT chat_id, id, sender, from_me, ts, text, kind FROM (
			SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?
		) ORDER BY ts ASC, id ASC`, chatID, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []Message
	for rows.Next() {
		var m Message
		var fromMe int
		var ts int64
		if err := rows.Scan(&m.ChatID, &m.ID, &m.Sender, &fromMe, &ts, &m.Text, &m.Kind); err != nil {
			return nil, err
		}
		m.FromMe = fromMe != 0
		m.Time = time.UnixMilli(ts).UTC()
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

type scanner interface{ Scan(dest ...any) error }

func scanChat(row scanner) (Chat, error) {
	var c Chat
	var group int
	var ts int64
	if err := row.Scan(&c.ID, &c.Name, &group, &c.Unread, &ts, &c.Preview); err != nil {
		return Chat{}, err
	}
	c.Group = group != 0
	if ts > 0 {
		c.LastTime = time.UnixMilli(ts).UTC()
	}
	return c, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
