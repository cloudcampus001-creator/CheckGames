import type { Metadata, Viewport } from "next";
import { Lilita_One, Nunito } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Lilita One: chunky game headlines. Nunito: soft, rounded and easy to read.
const display = Lilita_One({
  display: "swap",
  subsets: ["latin"],
  variable: "--f-display",
  weight: "400",
});

const body = Nunito({
  display: "swap",
  subsets: ["latin"],
  variable: "--f-body",
});

export const metadata: Metadata = {
  title: "Cheque-games",
  description: "The Cameroonian card game: finish your cards, say check, win.",
};

export const viewport: Viewport = {
  initialScale: 1,
  themeColor: "#0d9a58",
  viewportFit: "cover",
  width: "device-width",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${display.variable} ${body.variable}`} lang="en">
      <body>{children}</body>
    </html>
  );
}
