import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy — Cook With Me',
  description:
    'Privacy Policy for the Cook With Me application and Kitchen Agent mobile service.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2 font-display text-lg font-bold text-stone-900">
            <span aria-hidden="true">🍳</span>
            <span>Cook With Me</span>
          </Link>
          <Link
            href="/"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-50"
          >
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 pt-10 pb-20 sm:px-6 sm:pt-14 lg:px-8">
        <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-10">
          <div className="border-b border-stone-200 pb-6">
            <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
              Official Policy
            </span>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
              Privacy Policy
            </h1>
            <p className="mt-2 text-sm text-stone-500">
              Effective Date: October 21, 2026 · Application: Cook With Me (<code>com.freebuff.cookwithme</code>)
            </p>
          </div>

          <div className="mt-8 space-y-8 text-sm leading-relaxed text-stone-700 sm:text-base">
            <section>
              <h2 className="text-lg font-bold text-stone-900">1. Overview</h2>
              <p className="mt-2">
                This Privacy Policy explains how <strong>Cook With Me</strong> (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;)
                collects, uses, and protects your information when you use our web application and mobile application
                (Package ID: <code>com.freebuff.cookwithme</code>). We are committed to protecting your personal data and
                respecting your privacy.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">2. Information We Collect</h2>
              <p className="mt-2">
                We only collect data necessary to provide and improve the hands-free cooking and kitchen management experience:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-stone-700">
                <li>
                  <strong>Account Information:</strong> When you sign in using Firebase Authentication (such as Google Sign-In
                  or email), we collect your name, email address, profile picture (if provided by your identity provider), and a
                  unique user identifier (UID) to authenticate you and sync your data across devices.
                </li>
                <li>
                  <strong>Microphone &amp; Audio Input:</strong> With your explicit runtime permission, the application accesses
                  your device microphone to listen for hands-free voice commands while you are in an active cooking session.
                  Voice input is processed transiently in real time to interpret cooking steps and commands. We do not sell your
                  audio recordings or use them for advertising.
                </li>
                <li>
                  <strong>Kitchen &amp; Recipe Content:</strong> Recipes you create or save, pantry inventory items, grocery checklists,
                  leftovers, kitchen timers, and dietary preferences are stored in our secure database to personalize your experience.
                </li>
                <li>
                  <strong>Device &amp; Usage Information:</strong> Technical data such as device model, operating system version,
                  app version, and error diagnostics may be gathered to diagnose issues, maintain stability, and prevent fraud.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">3. How We Use Your Information</h2>
              <p className="mt-2">
                We use collected information solely for the following operational purposes:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-stone-700">
                <li>To authenticate your session and persist your recipes, pantry items, and cooking progress.</li>
                <li>To provide hands-free voice-assisted cooking guidance.</li>
                <li>To generate tailored recipe suggestions, substitutions, and kitchen tips based on your dietary preferences.</li>
                <li>To maintain application reliability, prevent abuse, and enforce service quotas.</li>
                <li>To process purchases or subscription entitlements through Google Play Billing (if applicable).</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">4. Third-Party Service Providers</h2>
              <p className="mt-2">
                We work with reputable cloud infrastructure providers that process data on our behalf under strict confidentiality
                and security standards:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-stone-700">
                <li>
                  <strong>Google Firebase &amp; Google Cloud Platform:</strong> Provides user authentication, secure database storage
                  (Cloud Firestore), serverless hosting, and security attestation (Firebase App Check).
                </li>
                <li>
                  <strong>Google Gemini AI:</strong> Processes natural language prompts to assist in step-by-step cooking walkthroughs
                  and recipe creation.
                </li>
                <li>
                  <strong>Google Play Services:</strong> Manages application distribution, in-app billing verification, and Trusted Web
                  Activity integration on Android devices.
                </li>
              </ul>
              <p className="mt-2">
                We do not sell, rent, or trade your personal data to advertisers or third-party data brokers.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">5. Data Security</h2>
              <p className="mt-2">
                We implement industry-standard administrative and technical safeguards to protect your personal information:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-stone-700">
                <li>All data in transit is encrypted using Secure Sockets Layer / Transport Layer Security (HTTPS / TLS 1.3).</li>
                <li>Stored data is protected using AES-256 encryption at rest on Google Cloud infrastructure.</li>
                <li>Access to user data is protected by strict Firebase Security Rules that ensure users can only access their own records.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">6. Data Retention and Account Deletion</h2>
              <p className="mt-2">
                We retain your information as long as your account remains active or as needed to provide our services. You have the
                right to access, modify, or permanently delete your data at any time:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-6 text-stone-700">
                <li>
                  <strong>Account &amp; Data Deletion:</strong> You can request immediate and permanent deletion of your account,
                  recipes, pantry items, and all associated personal data by emailing us at{' '}
                  <a href="mailto:cherouri@gmail.com" className="font-medium text-amber-800 underline underline-offset-2">
                    cherouri@gmail.com
                  </a>{' '}
                  with the subject &quot;Delete My Account&quot;. All user data is purged within 30 days of request.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">7. Children&apos;s Privacy</h2>
              <p className="mt-2">
                Our application is not directed at children under the age of 13. We do not knowingly collect or solicit personal
                information from children. If you believe a child under 13 has provided us with personal information, please contact
                us immediately and we will delete such information promptly.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-stone-900">8. Changes to This Privacy Policy</h2>
              <p className="mt-2">
                We may update this Privacy Policy from time to time to reflect changes in our practices, features, or applicable laws.
                Any updates will be posted directly on this page with an updated Effective Date.
              </p>
            </section>

            <section className="border-t border-stone-200 pt-6">
              <h2 className="text-lg font-bold text-stone-900">9. Contact Us</h2>
              <p className="mt-2">
                If you have questions, feedback, or data privacy requests regarding Cook With Me, please contact:
              </p>
              <div className="mt-3 rounded-xl bg-stone-50 p-4 text-stone-800">
                <p className="font-semibold text-stone-900">Laredj Chehrouri (Cook With Me)</p>
                <p className="mt-1">
                  Email:{' '}
                  <a href="mailto:cherouri@gmail.com" className="text-amber-800 underline underline-offset-2">
                    cherouri@gmail.com
                  </a>
                </p>
                <p className="mt-1 text-xs text-stone-500">Newark, DE 19711, United States</p>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
