import { Switch, Route, Router as WouterRouter } from "wouter";
import { motion } from "framer-motion";
import { Shield, Cpu, Globe, Activity, Zap, TrendingUp } from "lucide-react";
import { StoreHydrator } from "./components/StoreHydrator";
import { PiConnectButton } from "./components/PiConnectButton";
import { UniversalDepositComponent } from "./components/UniversalDepositComponent";
import { PaymentStatusTracker } from "./components/PaymentStatusTracker";
import { useLuminaStore } from "./lib/store";

function AnimatedBackground() {
  return (
    <>
      <div className="lumina-orb lumina-orb-gold" aria-hidden="true" />
      <div className="lumina-orb lumina-orb-purple" aria-hidden="true" />
      <div className="lumina-orb lumina-orb-teal" aria-hidden="true" />
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          backgroundImage: `
            linear-gradient(rgba(240,192,64,0.015) 1px, transparent 1px),
            linear-gradient(90deg, rgba(240,192,64,0.015) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
        aria-hidden="true"
      />
    </>
  );
}

const STAT_CARDS = [
  {
    icon: Shield,
    label: "Vault Status",
    value: "Awaiting Auth",
    color: "text-yellow-400",
    bg: "bg-yellow-400/8",
  },
  {
    icon: Cpu,
    label: "Auth Protocol",
    value: "Pi Network",
    color: "text-[#F0C040]",
    bg: "bg-[#F0C040]/8",
  },
  {
    icon: Globe,
    label: "Network",
    value: "Pi Mainnet",
    color: "text-emerald-400",
    bg: "bg-emerald-400/8",
  },
];

const NETWORK_CHAINS = [
  { name: "Pi Network",      status: "active",  color: "bg-emerald-400", ring: "ripple-dot-green" },
  { name: "Bitcoin Bridge",  status: "pending", color: "bg-white/25",    ring: null },
  { name: "Ethereum Bridge", status: "pending", color: "bg-white/25",    ring: null },
  { name: "Soroban RPC",     status: "pending", color: "bg-white/25",    ring: null },
];

function DashboardPage() {
  const { balances } = useLuminaStore();

  const totalAssets = [
    { label: "π Pi",   value: balances.pi,    icon: "π" },
    { label: "piBTC",  value: balances.piBTC,  icon: "₿" },
    { label: "piETH",  value: balances.piETH,  icon: "Ξ" },
    { label: "piUSDT", value: balances.piUSDT, icon: "$" },
  ];

  return (
    <div className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 lg:px-8">

      <motion.div
        className="mb-10"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: "easeOut" }}
      >
        <div className="flex items-center gap-3 mb-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="ripple-dot ripple-dot-green absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          <span className="text-[11px] font-medium tracking-[0.15em] text-emerald-400/70 uppercase">
            Live · Zero-Trust · Omnichain
          </span>
        </div>
        <h1 className="text-gold-gradient text-5xl font-black tracking-tight leading-none mb-2">
          Dashboard
        </h1>
        <p className="text-sm text-white/35 font-medium">
          Real-time vault status across Pi Network and all connected chains
        </p>
      </motion.div>

      <motion.div
        className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
      >
        {totalAssets.map(({ label, value, icon }) => (
          <div key={label} className="stat-card rounded-2xl px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold tracking-widest text-white/30 uppercase">
                {label}
              </span>
              <span className="text-lg text-white/20">{icon}</span>
            </div>
            <p className="text-2xl font-black font-mono text-gold-gradient">
              {value}
            </p>
            <div className="mt-2 flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-white/20" />
              <span className="text-[10px] text-white/20">vault balance</span>
            </div>
          </div>
        ))}
      </motion.div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">

        <div className="lg:col-span-3 space-y-6">

          <motion.div
            className="glass-card rounded-2xl p-6"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
          >
            <div className="flex items-center gap-2 mb-5">
              <Zap className="h-4 w-4 text-[#F0C040]" />
              <h2 className="text-sm font-bold tracking-[0.15em] text-[#F0C040] uppercase">
                Vault Overview
              </h2>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {STAT_CARDS.map(({ icon: Icon, label, value, color, bg }) => (
                <div
                  key={label}
                  className="stat-card rounded-xl px-4 py-4 flex flex-col gap-2"
                >
                  <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                  <p className="text-[10px] font-semibold tracking-widest text-white/30 uppercase">
                    {label}
                  </p>
                  <p className={`text-sm font-bold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            className="glass-card rounded-2xl p-6"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.22 }}
          >
            <div className="flex items-center gap-2 mb-5">
              <Activity className="h-4 w-4 text-[#F0C040]" />
              <h2 className="text-sm font-bold tracking-[0.15em] text-[#F0C040] uppercase">
                Payment Status
              </h2>
            </div>
            <PaymentStatusTracker />
          </motion.div>

        </div>

        <motion.div
          className="lg:col-span-2"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.28 }}
        >
          <UniversalDepositComponent />
        </motion.div>

      </div>

      <motion.div
        className="mt-6 glass-card rounded-2xl px-6 py-5"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35 }}
      >
        <p className="mb-4 text-[10px] font-semibold tracking-[0.15em] text-white/30 uppercase">
          Omnichain Network Listeners
        </p>
        <div className="flex flex-wrap gap-6">
          {NETWORK_CHAINS.map(({ name, status, color, ring }) => (
            <div key={name} className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                {ring && (
                  <span className={`ripple-dot ${ring} absolute inline-flex h-full w-full rounded-full ${color}`} />
                )}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
              </span>
              <div>
                <p className="text-xs font-medium text-white/50">{name}</p>
                <p className={`text-[10px] ${status === "active" ? "text-emerald-400/70" : "text-white/20"}`}>
                  {status}
                </p>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col bg-[#0A0A0F] text-[#E8E8F0] antialiased overflow-x-hidden">
      <AnimatedBackground />
      <StoreHydrator />

      <header className="sticky top-0 z-50 border-b border-white/[0.06]"
        style={{
          background: "rgba(10,10,15,0.75)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
        }}
      >
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <div className="logo-glow">
                <span className="text-2xl text-[#F0C040] leading-none" aria-hidden="true">◆</span>
              </div>
              <div>
                <span className="text-base font-black tracking-[0.2em] text-gold-gradient uppercase">
                  Lumina
                </span>
                <span className="ml-2 text-[9px] font-semibold tracking-widest text-white/20 uppercase">
                  PLU · Vault
                </span>
              </div>
            </div>

            <nav aria-label="Primary navigation">
              <ul className="flex items-center gap-5">
                {["Dashboard", "Vault", "History"].map((page) => (
                  <li key={page} className="hidden sm:block">
                    <a
                      href={page === "Dashboard" ? "/" : `/${page.toLowerCase()}`}
                      className="nav-link text-[11px] font-semibold tracking-[0.15em] text-white/35 uppercase hover:text-[#F0C040] transition-colors duration-200"
                    >
                      {page}
                    </a>
                  </li>
                ))}
                <li>
                  <PiConnectButton />
                </li>
              </ul>
            </nav>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col">{children}</main>

      <footer className="relative z-10 border-t border-white/[0.05] px-6 py-5 text-center">
        <p className="text-[10px] tracking-[0.15em] text-white/15 uppercase">
          © {new Date().getFullYear()} Devright Labs · PLU-Lumina · All rights reserved
        </p>
      </footer>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="relative z-10 flex flex-1 items-center justify-center">
      <motion.div
        className="text-center"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <h1 className="text-8xl font-black text-gold-gradient">404</h1>
        <p className="mt-3 text-sm text-white/40">Page not found</p>
        <a
          href="/"
          className="mt-6 inline-flex items-center gap-2 rounded-xl border border-[#F0C040]/30 px-5 py-2.5 text-xs font-bold tracking-widest text-[#F0C040] uppercase hover:bg-[#F0C040]/10 transition-all duration-200"
        >
          Back to Dashboard
        </a>
      </motion.div>
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
