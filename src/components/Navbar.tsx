import type * as React from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Link } from "@/lib/router-compat";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import LogOut from "lucide-react/dist/esm/icons/log-out.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { AlertNotificationCenter } from "@/components/AlertNotificationCenter";
import { BrandMark } from "@/components/BrandLogo";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { isAdminAccount, isProfessionalAccount } from "@/lib/account";
import { RESOURCES_PATH } from "@/lib/navigation";

const AUTH_NAV_ITEMS = [
  { to: "/favoris", label: "Mes favoris" },
  { to: "/alertes", label: "Mes alertes" },
  { to: "/sales", label: "Annonces" },
  { to: "/tribunaux", label: "Tribunaux" },
  { to: "/avocats", label: "Avocats" },
] as const;

const PRO_NAV_ITEM = { to: "/publish", label: "Publier" } as const;
const ADMIN_NAV_ITEM = { to: "/admin", label: "Admin" } as const;
const HOME_NAV_ITEMS = [
  { to: "/sales", label: "Rechercher un bien" },
  { to: "/avocats", label: "Trouver un avocat" },
  { to: "/annonce-exemple", label: "Annonce exemple" },
  { to: "/accompagnement", label: "Offres" },
  { to: RESOURCES_PATH, label: "Ressources" },
  { to: "/a-propos", label: "À propos" },
] as const;
const NON_HOME_PUBLIC_NAV_ITEMS = HOME_NAV_ITEMS.filter((item) => item.to !== "/annonce-exemple");

export function Navbar() {
  const pathname = usePathname();
  const { user, profile, loading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isHome = pathname === "/";
  const isAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  const isSalesListing = pathname === "/sales" || pathname === "/sales/";
  const isProductPage = pathname === "/annonce-exemple" || /^\/sales\/[^/]+/.test(pathname);
  const admin = isAdminAccount(user, profile);
  const navItems = user
    ? [
        ...AUTH_NAV_ITEMS,
        { to: RESOURCES_PATH, label: "Ressources" },
        ...(isProfessionalAccount(user, profile) ? [PRO_NAV_ITEM] : []),
        ...(admin ? [ADMIN_NAV_ITEM] : []),
      ]
    : isHome
      ? HOME_NAV_ITEMS
      : NON_HOME_PUBLIC_NAV_ITEMS;

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  const closeMobileMenu = () => setMobileOpen(false);

  if (isAdminArea) return null;

  if (isSalesListing) return null;

  if (isProductPage) {
    return (
      <>
        <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-white/95 text-foreground shadow-sm backdrop-blur">
          <div className="flex h-16 w-full items-center gap-4 px-4 sm:px-6 lg:px-8">
            <Link
              to="/"
              className="inline-flex shrink-0 items-center gap-2 font-display text-2xl font-semibold text-foreground"
              aria-label="ImmoJudis — accueil"
            >
              <BrandMark variant="transparent" className="h-7 w-7" />
              <span>
                Immo<span className="text-[#8a5b24]">Judis</span>
              </span>
            </Link>

            <form
              action="/sales"
              method="get"
              className="hidden min-w-[18rem] max-w-xl flex-1 items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm shadow-inner md:flex"
            >
              <button
                type="submit"
                aria-label="Rechercher"
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <Search className="h-4 w-4" />
              </button>
              <label htmlFor="product-search" className="sr-only">
                Rechercher par région, département, ville ou code postal
              </label>
              <input
                id="product-search"
                name="q"
                type="search"
                placeholder="Région, département, ville, code postal..."
                autoComplete="off"
                className="w-full bg-transparent font-medium text-foreground outline-none placeholder:text-muted-foreground"
              />
            </form>

            <nav
              className="hidden items-center gap-1 text-sm font-semibold text-foreground lg:flex"
              aria-label="Navigation produit"
            >
              {navItems.slice(0, 5).map((item) => (
                <NavLink key={item.label} to={item.to} chevron={hasNavChevron(item)}>
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">
              {!loading && user ? (
                <>
                  <AlertNotificationCenter />
                  <button
                    type="button"
                    onClick={() => supabase.auth.signOut()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold hover:border-gold/50 hover:text-gold-soft"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Déconnexion
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    search={{ redirect: undefined }}
                    className="rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold hover:border-gold/50 hover:text-gold-soft"
                  >
                    Connexion
                  </Link>
                  <Link
                    to="/login"
                    search={{ mode: "investor", redirect: undefined }}
                    className="rounded-md bg-gold-soft px-3 py-2 text-sm font-semibold text-white hover:bg-gold"
                  >
                    S'inscrire
                  </Link>
                </>
              )}
            </div>

            <button
              type="button"
              aria-label="Ouvrir le menu"
              aria-controls="product-mobile-navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="ml-auto inline-grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border bg-white md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>

          {mobileOpen ? (
            <div className="ij-mobile-overlay" role="dialog" aria-modal="true">
              <button
                type="button"
                aria-label="Fermer le menu"
                className="ij-mobile-backdrop"
                onClick={closeMobileMenu}
              />
              <aside id="product-mobile-navigation" className="ij-mobile-panel">
                <div className="ij-mobile-panel-head">
                  <HeaderLogo onClick={closeMobileMenu} />
                  <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                  <form
                    action="/sales"
                    method="get"
                    className="mb-3 flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm"
                  >
                    <button
                      type="submit"
                      aria-label="Rechercher"
                      className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                    >
                      <Search className="h-4 w-4" />
                    </button>
                    <label htmlFor="product-mobile-search" className="sr-only">
                      Rechercher par région, département, ville ou code postal
                    </label>
                    <input
                      id="product-mobile-search"
                      name="q"
                      type="search"
                      placeholder="Région, département, ville, CP..."
                      autoComplete="off"
                      className="w-full bg-transparent outline-none"
                    />
                  </form>
                  <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                    {navItems.map((item) => (
                      <MobileNavLink key={item.label} to={item.to} onClick={closeMobileMenu}>
                        {item.label}
                      </MobileNavLink>
                    ))}
                  </nav>
                  {!loading && user ? (
                    <div className="mb-3">
                      <AlertNotificationCenter mobile />
                    </div>
                  ) : null}
                </div>
              </aside>
            </div>
          ) : null}
        </header>
        <div className="h-16" aria-hidden />
      </>
    );
  }

  if (isHome) {
    return (
      <header className="ij-site-header">
        <div className="ij-site-header-inner">
          <HeaderLogo />

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {HOME_NAV_ITEMS.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
                {hasNavChevron(item) ? <ChevronDown aria-hidden className="h-4 w-4" /> : null}
              </Link>
            ))}
          </nav>

          <div className="ij-home-actions">
            <Link to="/login" search={{ redirect: undefined }} className="ij-login-button">
              Connexion
            </Link>
            <Link
              to="/login"
              search={{ mode: "investor", redirect: undefined }}
              className="ij-signup-button"
            >
              S'inscrire
            </Link>
          </div>

          <button
            type="button"
            aria-label="Ouvrir le menu"
            aria-controls="home-mobile-navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="ij-home-menu-button"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>

        {mobileOpen ? (
          <div className="ij-mobile-overlay" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Fermer le menu"
              className="ij-mobile-backdrop"
              onClick={closeMobileMenu}
            />
            <aside id="home-mobile-navigation" className="ij-mobile-panel">
              <div className="ij-mobile-panel-head">
                <HeaderLogo onClick={closeMobileMenu} />
                <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                {HOME_NAV_ITEMS.map((item) => (
                  <Link key={item.label} to={item.to} onClick={closeMobileMenu}>
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="ij-mobile-actions">
                <Link
                  to="/login"
                  search={{ redirect: undefined }}
                  onClick={closeMobileMenu}
                  className="ij-login-button"
                >
                  Connexion
                </Link>
                <Link
                  to="/login"
                  search={{ mode: "investor", redirect: undefined }}
                  onClick={closeMobileMenu}
                  className="ij-signup-button"
                >
                  S'inscrire
                </Link>
              </div>
            </aside>
          </div>
        ) : null}
      </header>
    );
  }

  return (
    <>
      <header className="ij-site-header">
        <div className="ij-site-header-inner">
          <HeaderLogo />

          <nav className="ij-home-nav" aria-label="Navigation principale">
            {navItems.map((item) => (
              <NavLink key={item.label} to={item.to} chevron={hasNavChevron(item)}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ij-home-actions">
            {!loading && user ? (
              <>
                <AlertNotificationCenter />
                <button onClick={() => supabase.auth.signOut()} className="ij-login-button gap-2">
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Déconnexion</span>
                </button>
              </>
            ) : (
              <>
                <Link to="/login" search={{ redirect: undefined }} className="ij-login-button">
                  Connexion
                </Link>
                <Link
                  to="/login"
                  search={{ mode: "investor", redirect: undefined }}
                  className="ij-signup-button"
                >
                  S'inscrire
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            aria-label="Ouvrir le menu"
            aria-controls="mobile-navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="ij-home-menu-button"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>

        {mobileOpen ? (
          <div className="ij-mobile-overlay" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Fermer le menu"
              className="ij-mobile-backdrop"
              onClick={closeMobileMenu}
            />
            <aside id="mobile-navigation" className="ij-mobile-panel">
              <div className="ij-mobile-panel-head">
                <HeaderLogo onClick={closeMobileMenu} />
                <button type="button" aria-label="Fermer le menu" onClick={closeMobileMenu}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <nav className="ij-mobile-nav" aria-label="Navigation mobile">
                  {navItems.map((item) => (
                    <MobileNavLink key={item.label} to={item.to} onClick={closeMobileMenu}>
                      {item.label}
                    </MobileNavLink>
                  ))}
                </nav>

                <div className="ij-mobile-actions">
                  {!loading && user ? (
                    <>
                      <AlertNotificationCenter mobile />
                      <button
                        onClick={() => {
                          closeMobileMenu();
                          void supabase.auth.signOut();
                        }}
                        className="ij-login-button w-full gap-2"
                      >
                        <LogOut className="h-4 w-4" />
                        Déconnexion
                      </button>
                    </>
                  ) : (
                    <>
                      <Link
                        to="/login"
                        search={{ redirect: undefined }}
                        onClick={closeMobileMenu}
                        className="ij-login-button w-full"
                      >
                        Connexion
                      </Link>
                      <Link
                        to="/login"
                        search={{ mode: "investor", redirect: undefined }}
                        onClick={closeMobileMenu}
                        className="ij-signup-button w-full"
                      >
                        S'inscrire
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </aside>
          </div>
        ) : null}
      </header>
      <div className="ij-header-spacer" aria-hidden />
    </>
  );
}

function HeaderLogo({ onClick }: { onClick?: () => void }) {
  return (
    <Link to="/" onClick={onClick} className="ij-home-logo" aria-label="ImmoJudis — accueil">
      <span className="ij-home-logo-mark" aria-hidden="true">
        <BrandMark variant="transparent" className="h-6 w-6" />
      </span>
      <span>
        <strong>
          Immo<span>Judis</span>
        </strong>
        <small>Les ventes immobilières en toute clarté</small>
      </span>
    </Link>
  );
}

function hasNavChevron(item: { readonly to: string; readonly label: string }): boolean {
  return "chevron" in item && (item as { readonly chevron?: unknown }).chevron === true;
}

function NavLink({
  to,
  children,
  chevron,
}: {
  to: string;
  children: React.ReactNode;
  chevron?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="rounded-full px-3 py-2 transition-colors hover:bg-[#c98d45]/10 hover:text-[#8a5b24]"
      activeProps={{ className: "bg-[#c98d45]/10 text-[#8a5b24]" }}
    >
      {children}
      {chevron ? <ChevronDown aria-hidden className="h-4 w-4" /> : null}
    </Link>
  );
}

function MobileNavLink({
  to,
  children,
  onClick,
}: {
  to: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      activeOptions={{ exact: true }}
      className="border-b border-[rgb(19_34_56_/_8%)] py-4 transition-colors hover:text-[#8a5b24]"
      activeProps={{ className: "text-[#8a5b24]" }}
    >
      {children}
    </Link>
  );
}
