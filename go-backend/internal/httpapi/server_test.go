package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/advisor"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
)

func TestHostOriginFreshnessAndNoSigning(t *testing.T) {
	s := &State{}
	h := New("127.0.0.1:7780", s, advisor.New("", "deepseek/test"))
	test := func(method, path, host, origin string, want int) {
		t.Helper()
		r := httptest.NewRequest(method, "http://"+host+path, nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Bot-UI", "1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s status=%d body=%s", method, path, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), `"live_signing":true`) {
			t.Fatal("signing enabled")
		}
	}
	test("GET", "/api/health", "evil.example", "", 403)
	test("GET", "/api/ready", "127.0.0.1:7780", "", 503)
	test("POST", "/api/analyze", "127.0.0.1:7780", "https://evil.example", 403)
	now := time.Now()
	s.Publish(evm.Report{Mode: "paper", ScannedAt: now, BlockTime: now})
	test("GET", "/api/ready", "127.0.0.1:7780", "", 200)
	test("POST", "/api/analyze", "127.0.0.1:7780", "http://127.0.0.1:7780", 503)
	test("POST", "/api/arm", "127.0.0.1:7780", "http://127.0.0.1:7780", 405)
	test("POST", "/api/live/arm", "127.0.0.1:7780", "http://127.0.0.1:7780", 409)
	test("POST", "/api/live/arm", "127.0.0.1:7780", "https://evil.example", 403)
	test("POST", "/api/live/disarm", "127.0.0.1:7780", "http://127.0.0.1:7780", 200)
	s.Fail()
	test("GET", "/api/ready", "127.0.0.1:7780", "", 503)
	s.Publish(evm.Report{Mode: "paper", ScannedAt: now.Add(-time.Hour), BlockTime: now})
	test("GET", "/api/ready", "127.0.0.1:7780", "", 503)
}
