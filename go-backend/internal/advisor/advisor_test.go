package advisor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
)

func TestAnalysisIsBoundedAndReadOnly(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing auth")
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
		}
		if body["max_tokens"] != float64(900) || body["tools"] != nil {
			t.Error("unbounded output or tools enabled")
		}
		b, _ := json.Marshal(body)
		if strings.Contains(string(b), "test-key") {
			t.Error("key leaked into prompt")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Paper scan only. test-key"}}]}`))
	}))
	defer s.Close()
	a := New("test-key", "deepseek/test")
	a.endpoint = s.URL
	a.client = s.Client()
	r, e := a.Analyze(context.Background(), evm.Report{Mode: "paper", Block: 123})
	if e != nil {
		t.Fatal(e)
	}
	if !r.AdvisoryOnly || r.Block != 123 || strings.Contains(r.Text, "test-key") {
		t.Fatal("invalid advisory", r)
	}
	if _, e = a.Analyze(context.Background(), evm.Report{}); !errors.Is(e, ErrRateLimited) {
		t.Fatal("cooldown missing")
	}
	if calls != 1 {
		t.Fatal("unexpected retries")
	}
}
func TestModelErrorsDoNotExposeProviderBody(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte("sensitive provider details"))
	}))
	defer s.Close()
	a := New("key", "deepseek/test")
	a.endpoint = s.URL
	a.client = s.Client()
	_, e := a.Analyze(context.Background(), evm.Report{})
	if e == nil || strings.Contains(e.Error(), "sensitive") {
		t.Fatal("bad error handling")
	}
	if _, e = New("", "deepseek/test").Analyze(context.Background(), evm.Report{}); !errors.Is(e, ErrDisabled) {
		t.Fatal("missing disabled guard")
	}
}
