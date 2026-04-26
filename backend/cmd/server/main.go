// Package main is the entry point for the Lumina-Core backend API server.
//
// It registers three primary route groups:
//   - /auth/pi-handshake  – Pi Network UID verification & JWT issuance
//   - /vault/create       – Sub-Wallet vault provisioning
//   - /sig/validate       – 2-of-2 multi-signature validation
//
// All routes follow a zero-trust model: every inbound request must carry a
// valid Pi Network access-token or a previously issued Lumina JWT.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/mux"

	"github.com/devwrightlabs/plu-lumina/backend/internal/handlers"
	"github.com/devwrightlabs/plu-lumina/backend/internal/middleware"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	r := mux.NewRouter()

	// Global middleware applied to every request.
	r.Use(middleware.RequestLogger)
	r.Use(middleware.SecurityHeaders)

	// ─── Public routes (no Lumina JWT required) ────────────────────────────────
	// POST /auth/pi-handshake
	//   Accepts a Pi Network auth payload, verifies the access-token with the Pi
	//   Platform API, and returns a short-lived Lumina JWT on success.
	r.Handle("/auth/pi-handshake",
		http.HandlerFunc(handlers.PiHandshake),
	).Methods(http.MethodPost)

	// ─── Protected routes (Lumina JWT required) ────────────────────────────────
	protected := r.PathPrefix("/").Subrouter()
	protected.Use(middleware.RequireJWT)

	// POST /vault/create
	//   Creates a new Sub-Wallet vault tied to the authenticated Pi UID.
	//   Returns the vault ID and the Lumina Agent's Ed25519 public key for the
	//   owner to co-sign subsequent operations.
	protected.Handle("/vault/create",
		http.HandlerFunc(handlers.VaultCreate),
	).Methods(http.MethodPost)

	// POST /sig/validate
	//   Accepts two signatures (Owner + Lumina Agent) and the serialised
	//   transaction envelope, verifies both signatures off-chain, then submits
	//   the signed XDR to the Soroban contract for on-chain execution.
	protected.Handle("/sig/validate",
		http.HandlerFunc(handlers.SigValidate),
	).Methods(http.MethodPost)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown on SIGINT / SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Lumina-Core backend listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-stop
	log.Println("Shutting down Lumina-Core backend…")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("forced shutdown: %v", err)
	}

	log.Println("Server stopped cleanly.")
}
