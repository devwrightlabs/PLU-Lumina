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
	"github.com/devwrightlabs/plu-lumina/backend/internal/repository"
	"github.com/devwrightlabs/plu-lumina/backend/internal/services"
	"github.com/devwrightlabs/plu-lumina/backend/pkg/piclient"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Initialise the Pi Network API client.  This reads PI_API_KEY from the
	// environment and fails fast if it is absent, preventing the server from
	// accepting requests it cannot service.
	if err := handlers.InitPiClient(piclient.Config{}); err != nil {
		log.Fatalf("failed to initialise Pi API client: %v", err)
	}

	// ─── Phase 6: Database connection ─────────────────────────────────────────
	// Open the Supabase/PostgreSQL connection pool.  A 10-second timeout is
	// applied so the server fails fast on misconfigured DATABASE_URL rather
	// than hanging indefinitely.
	dbCtx, dbCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dbCancel()

	txRepo, err := repository.NewPgxTransactionRepo(dbCtx)
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer txRepo.Close()

	// ─── Phase 6: AI Co-Signer initialisation ────────────────────────────────
	aiSigner, err := services.NewAISigner(txRepo)
	if err != nil {
		log.Fatalf("failed to initialise AI co-signer: %v", err)
	}

	// Initialise the multi-sig transaction service.  The in-memory store is
	// ready for request serving as soon as this call returns.
	handlers.InitTransactionService()

	// Wire the AI signer into the handler layer so the agent-sign endpoint
	// can trigger risk assessment and signature generation via the repository.
	handlers.InitAISigner(aiSigner)

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

	// ─── Phase 5: Multi-Sig Transaction Orchestration routes ──────────────────
	// POST /tx/initiate
	//   Initiates a new 2-of-2 multi-sig transaction and returns it in the
	//   pending_owner_sig state.
	protected.Handle("/tx/initiate",
		http.HandlerFunc(handlers.TxInitiate),
	).Methods(http.MethodPost)

	// GET /tx/{txID}
	//   Returns the current lifecycle state of a multi-sig transaction.
	protected.Handle("/tx/{txID}",
		http.HandlerFunc(handlers.TxGetStatus),
	).Methods(http.MethodGet)

	// POST /tx/{txID}/sign
	//   Records the vault owner's Ed25519 signature and advances the transaction
	//   to pending_agent_sig.
	protected.Handle("/tx/{txID}/sign",
		http.HandlerFunc(handlers.TxOwnerSign),
	).Methods(http.MethodPost)

	// POST /tx/{txID}/agent-sign
	//   Records the Lumina Agent's Ed25519 counter-signature and advances the
	//   transaction to ready_to_execute.
	protected.Handle("/tx/{txID}/agent-sign",
		http.HandlerFunc(handlers.TxAgentSign),
	).Methods(http.MethodPost)

	// POST /tx/{txID}/execute
	//   Finalises the transaction by verifying both signatures are present and
	//   advancing the state to executed.  On-chain Soroban submission is wired
	//   in Phase 6.
	protected.Handle("/tx/{txID}/execute",
		http.HandlerFunc(handlers.TxExecute),
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
