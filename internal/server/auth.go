package server

import (
	"crypto/subtle"
	"net/http"
)

func (s *Server) authorized(r *http.Request) bool {
	return subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) == 1
}
