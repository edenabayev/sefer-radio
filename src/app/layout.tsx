import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "רדיו ספרים",
  description: "מחפשים ספר, ושומעים ולומדים אותו באוטו",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "רדיו ספרים", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#111418",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
