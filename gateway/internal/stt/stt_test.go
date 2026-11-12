package stt

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWAVWrapsPCMInA16kMonoHeader(t *testing.T) {
	pcm := []byte{1, 2, 3, 4}
	wav := WAV(pcm)
	if len(wav) != 44+len(pcm) || string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || string(wav[36:40]) != "data" {
		t.Fatalf("not a canonical WAV: % x", wav[:44])
	}
	if got := binary.LittleEndian.Uint32(wav[4:8]); got != uint32(36+len(pcm)) {
		t.Errorf("RIFF size = %d", got)
	}
	if ch, rate, bits := binary.LittleEndian.Uint16(wav[22:24]), binary.LittleEndian.Uint32(wav[24:28]), binary.LittleEndian.Uint16(wav[34:36]); ch != 1 || rate != 16000 || bits != 16 {
		t.Errorf("channels=%d rate=%d bits=%d, want 1 16000 16", ch, rate, bits)
	}
	if got := binary.LittleEndian.Uint32(wav[40:44]); got != uint32(len(pcm)) || !bytes.Equal(wav[44:], pcm) {
		t.Errorf("data chunk wrong")
	}
}

type call struct {
	lang     string
	filename string
	body     []byte
}

func fakeServer(t *testing.T, answers map[string]string) (*httptest.Server, *[]call) {
	t.Helper()
	var calls []call
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, header, err := r.FormFile("audio")
		if err != nil {
			t.Errorf("no audio form file: %v", err)
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		body, _ := io.ReadAll(file)
		lang := r.URL.Query().Get("lang")
		calls = append(calls, call{lang: lang, filename: header.Filename, body: body})
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, answers[lang])
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestTranscribeSendsWAVAndReturnsText(t *testing.T) {
	srv, calls := fakeServer(t, map[string]string{"auto": `{"text":" Ajung în zece minute. ","lang":"ro"}`})
	c := &Client{URL: srv.URL, Languages: []string{"ro", "en"}}

	got, err := c.Transcribe(context.Background(), []byte{9, 9, 9, 9})
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "Ajung în zece minute." || got.Language != "ro" {
		t.Errorf("result = %+v", got)
	}
	if len(*calls) != 1 || (*calls)[0].lang != "auto" || !strings.HasSuffix((*calls)[0].filename, ".wav") || string((*calls)[0].body[:4]) != "RIFF" {
		t.Errorf("calls = %+v", *calls)
	}
}

func TestTranscribeRetriesInTheFirstLanguageWhenDetectionIsOutsideTheList(t *testing.T) {
	// Short clips are often detected as some other language; the speaker only uses the listed ones.
	srv, calls := fakeServer(t, map[string]string{
		"auto": `{"text":"Ajung in zece minute","lang":"it"}`,
		"ro":   `{"text":"Ajung în zece minute","lang":"ro"}`,
	})
	c := &Client{URL: srv.URL, Languages: []string{"ro", "en"}}

	got, err := c.Transcribe(context.Background(), []byte{9, 9})
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "Ajung în zece minute" || got.Language != "ro" || len(*calls) != 2 || (*calls)[1].lang != "ro" {
		t.Errorf("result = %+v, calls = %d", got, len(*calls))
	}
}

func TestTranscribeReportsServerErrors(t *testing.T) {
	srv, _ := fakeServer(t, map[string]string{"auto": `{"text":"","error":"decode_failed"}`})
	c := &Client{URL: srv.URL}
	if _, err := c.Transcribe(context.Background(), []byte{1, 2}); err == nil || !strings.Contains(err.Error(), "decode_failed") {
		t.Errorf("err = %v, want decode_failed", err)
	}
}

func TestTranscribeReportsHTTPFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	if _, err := (&Client{URL: srv.URL}).Transcribe(context.Background(), []byte{1, 2}); err == nil {
		t.Error("want an error for HTTP 500")
	}
}
