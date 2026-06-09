// AMM handler wiring for the Lumina-Core backend.
// This file follows the InitAISigner pattern established in Phase 6:
// the AMMService is initialised once at server startup and injected here
// so that future AMM HTTP handlers can access it without coupling the
// handler layer to the service constructor.
package handlers

import (
	"sync"

	"github.com/devwrightlabs/plu-lumina/backend/internal/services"
)

// ammService is the package-level AMMService instance.
var ammService *services.AMMService

// ammServiceOnce ensures the write to ammService is visible to all goroutines
// that subsequently read it (Go memory model guarantee).
var ammServiceOnce sync.Once

// InitAMMService stores the shared AMMService for use by AMM HTTP handlers.
// Must be called once during server startup; subsequent calls are no-ops.
func InitAMMService(s *services.AMMService) {
	ammServiceOnce.Do(func() {
		ammService = s
	})
}
