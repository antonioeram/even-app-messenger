// Package stt sends recorded speech to the speech-to-text server on the
// home network and returns the text. Audio never leaves the home network.
package stt

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// The format the glasses deliver and Whisper expects.
const (
	SampleRate     = 16000
	BytesPerSample = 2
)

// Result is one transcription.
type Result struct {
	Text string
	// Language is the detected or forced language code, e.g. "ro".
	Language string
}

// Client talks to a server with a POST endpoint that takes a multipart
// "audio" file and a "lang" query parameter ("auto" detects the language)
// and answers {"text": ..., "lang": ...}.
type Client struct {
	// URL is the endpoint, e.g. http://10.0.10.42:8770/stt.
	URL string
	// Languages the speaker uses. When detection picks another one, the
	// clip is transcribed again in the first language. Empty accepts any.
	Languages []string
	// HTTP defaults to a client with a 60 s timeout.
	HTTP *http.Client
}

// Transcribe returns the text spoken in pcm (16 kHz, 16 bit, mono, little endian).
func (c *Client) Transcribe(ctx context.Context, pcm []byte) (Result, error) {
	wav := WAV(pcm)
	result, err := c.post(ctx, wav, "auto")
	if err != nil {
		return Result{}, err
	}
	if len(c.Languages) > 0 && !slices.Contains(c.Languages, result.Language) {
		return c.post(ctx, wav, c.Languages[0])
	}
	return result, nil
}

func (c *Client) post(ctx context.Context, wav []byte, lang string) (Result, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("audio", "speech.wav")
	if err != nil {
		return Result{}, err
	}
	if _, err := part.Write(wav); err != nil {
		return Result{}, err
	}
	if err := form.Close(); err != nil {
		return Result{}, err
	}

	endpoint, err := url.Parse(c.URL)
	if err != nil {
		return Result{}, fmt.Errorf("speech-to-text URL: %w", err)
	}
	query := endpoint.Query()
	query.Set("lang", lang)
	endpoint.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), &body)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())

	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("speech-to-text server: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("speech-to-text server: HTTP %d", resp.StatusCode)
	}
	var answer struct {
		Text  string `json:"text"`
		Lang  string `json:"lang"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&answer); err != nil {
		return Result{}, fmt.Errorf("speech-to-text server: %w", err)
	}
	if answer.Error != "" {
		return Result{}, errors.New("speech-to-text server: " + answer.Error)
	}
	return Result{Text: strings.TrimSpace(answer.Text), Language: answer.Lang}, nil
}

// WAV puts a canonical 44-byte header in front of 16 kHz mono 16-bit PCM.
func WAV(pcm []byte) []byte {
	const channels = 1
	header := make([]byte, 44, 44+len(pcm))
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+len(pcm)))
	copy(header[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:], 16) // fmt chunk size
	binary.LittleEndian.PutUint16(header[20:], 1)  // PCM
	binary.LittleEndian.PutUint16(header[22:], channels)
	binary.LittleEndian.PutUint32(header[24:], SampleRate)
	binary.LittleEndian.PutUint32(header[28:], SampleRate*channels*BytesPerSample)
	binary.LittleEndian.PutUint16(header[32:], channels*BytesPerSample)
	binary.LittleEndian.PutUint16(header[34:], 8*BytesPerSample)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(len(pcm)))
	return append(header, pcm...)
}
