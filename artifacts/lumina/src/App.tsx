import { Switch, Route, Router as WouterRouter } from "wouter";
import { StoreHydrator } from "./components/StoreHydrator";
import { PiConnectButton } from "./components/PiConnectButton";
import { UniversalDepositComponent } from "./components/UniversalDepositComponent";
import { PaymentStatusTracker } from "./components/PaymentStatusTracker";

function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-[#F0C040]">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-white/40">
          Omnichain vault status · real-time · zero-trust
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
            <h2 className="mb-4 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
              Vault Overview
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[
                { label: "Vault Status", value: "Awaiting Auth" },
                { label: "Auth", value: "Pi Network" },
                { label: "Network", value: "Pi Mainnet" },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl bg-[#0A0A0F] px-4 py-3">
                  <p className="text-[10px] font-medium tracking-widest text-white/30 uppercase">
                    {label}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#F0C040]">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
            <h2 className="mb-4 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
              Payment Status
            </h2>
            <PaymentStatusTracker />
          </div>
        </div>

        <div className="lg:col-span-1">
          <UniversalDepositComponent />
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-[#F0C040]/10 bg-[#0F0F1A] px-6 py-4">
        <p className="mb-3 text-[10px] font-medium tracking-widest text-white/30 uppercase">
          Omnichain Network Listeners
        </p>
        <div className="flex flex-wrap gap-4">
          {[
            { chain: "Pi Network", status: "active" },
            { chain: "Bitcoin Bridge", status: "pending" },
            { chain: "Ethereum Bridge", status: "pending" },
            { chain: "Soroban RPC", status: "pending" },
          ].map(({ chain, status }) => (
            <div key={chain} className="flex items-center gap-2">
              <span
                className={[
                  "h-2 w-2 rounded-full",
                  status === "active"
                    ? "bg-green-400 animate-pulse"
                    : "bg-white/20",
                ].join(" ")}
              />
              <span className="text-xs text-white/40">
                {chain}{" "}
                <span className="text-white/20">·</span>{" "}
                <span
                  className={
                    status === "active" ? "text-green-400/70" : "text-white/20"
                  }
                >
                  {status}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-[#0A0A0F] text-[#E8E8F0] antialiased">
      <StoreHydrator />

      <header className="sticky top-0 z-50 flex items-center justify-between border-b border-[#F0C040]/10 bg-[#0A0A0F]/80 px-6 py-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="text-2xl text-[#F0C040]" aria-hidden="true">◆</span>
          <span className="text-lg font-bold tracking-widest text-[#F0C040] uppercase">
            Lumina
          </span>
        </div>
        <nav aria-label="Primary navigation">
          <ul className="flex items-center gap-6 text-xs font-medium tracking-widest text-white/40 uppercase">
            <li>
              <a href="/" className="transition-colors hover:text-[#F0C040]">
                Dashboard
              </a>
            </li>
            <li>
              <a href="/vault" className="transition-colors hover:text-[#F0C040]">
                Vault
              </a>
            </li>
            <li>
              <a href="/history" className="transition-colors hover:text-[#F0C040]">
                History
              </a>
            </li>
            <li>
              <PiConnectButton />
            </li>
          </ul>
        </nav>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>

      <footer className="border-t border-[#F0C040]/10 px-6 py-4 text-center text-[10px] tracking-widest text-white/20 uppercase">
        © {new Date().getFullYear()} Devright Labs · PLU-Lumina · All rights reserved
      </footer>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-[#F0C040]">404</h1>
        <p className="mt-2 text-sm text-white/40">Page not found</p>
        <a
          href="/"
          className="mt-4 inline-block rounded-xl border border-[#F0C040]/40 px-4 py-2 text-xs font-semibold tracking-widest text-[#F0C040] uppercase hover:bg-[#F0C040]/10 transition-colors"
        >
          Back to Dashboard
        </a>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}

export default App;
