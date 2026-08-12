import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Irises",
  description: "A thin debug client for the Irises assistant brain."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
