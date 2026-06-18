import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import { ConfirmProvider } from '@/components/ConfirmDialog';

export const metadata: Metadata = {
  title: {
    default: 'Orbit — Map Your World',
    template: '%s | Orbit',
  },
  description: 'Map your relationships, track follow-ups, and never lose a connection. Voice-first CRM with an interactive network graph.',
  keywords: ['CRM', 'network', 'relationship management', 'voice CRM', 'contact management', 'visual CRM', 'personal CRM'],
  authors: [{ name: 'Orbit' }],
  creator: 'Orbit',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    siteName: 'Orbit',
    title: 'Orbit — Map Your World',
    description: 'Map your relationships, track follow-ups, and never lose a connection. Voice-first CRM with an interactive network graph.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Orbit — Map Your World',
    description: 'Map your relationships, track follow-ups, and never lose a connection.',
  },
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.svg',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Orbit',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#08080c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem('crm-theme') || 'dark';
                  document.documentElement.setAttribute('data-theme', t);
                } catch(e){}
              })();
            `,
          }}
        />
        <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
        <link rel="icon" href="/icon-192.png?v=2" type="image/png" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <AuthProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </AuthProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
