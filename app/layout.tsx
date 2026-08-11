import type { Metadata, Viewport } from 'next';
import { Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Universal UI design system typography: Inter for the UI, IBM Plex Mono for
// metrics/timers/technical figures (both self-hosted at build time).
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Kitchen Agent',
  description: 'Voice-first intelligent cooking companion',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximumScale: pinching to zoom is a basic accessibility feature (axe
  // meta-viewport). The layout is fluid, so zoom never breaks the UI.
  themeColor: '#3157d5',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
