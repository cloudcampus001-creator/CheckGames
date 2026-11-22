import type { Metadata, Viewport } from "next";
import {
  Baloo_2,
  Bungee,
  Fredoka,
  Lilita_One,
  Nunito,
  Pacifico,
  Poppins,
  Quicksand,
  Righteous,
} from "next/font/google";
import type { ReactNode } from "react";
import { PrefsApplier } from "@/multiplayer/PrefsApplier";
import "./globals.css";

// The game fonts a player can choose from. Only the default ones are loaded up
// front; the others (preload: false) are fetched only if somebody picks them.
const lilita = Lilita_One({ display: "swap", subsets: ["latin"], variable: "--f-lilita", weight: "400" });
const bungee = Bungee({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-bungee", weight: "400" });
const fredoka = Fredoka({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-fredoka" });
const baloo = Baloo_2({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-baloo" });
const righteous = Righteous({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-righteous", weight: "400" });
const pacifico = Pacifico({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-pacifico", weight: "400" });
const nunito = Nunito({ display: "swap", subsets: ["latin"], variable: "--f-nunito" });
const poppins = Poppins({
  display: "swap",
  preload: false,
  subsets: ["latin"],
  variable: "--f-poppins",
  weight: ["400", "600", "700"],
});
const quicksand = Quicksand({ display: "swap", preload: false, subsets: ["latin"], variable: "--f-quicksand" });

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

const fonts = [lilita, bungee, fredoka, baloo, righteous, pacifico, nunito, poppins, quicksand]
  .map((font) => font.variable)
  .join(" ");

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={fonts} lang="en">
      <body>
        <PrefsApplier />
        {children}
      </body>
    </html>
  );
}
