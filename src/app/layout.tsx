import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "fairjudge",
  description: "A plain-language translator and fair judge for relationship conflicts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
