import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Knowledge Loop",
  description: "Private learning loop and public wiki."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav aria-label="Primary">
            <a href="/">Home</a> | <a href="/learn">Learning</a> | <a href="/wiki">Public wiki</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
