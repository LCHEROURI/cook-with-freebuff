import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Privacy Policy — Cook With Me',
  description:
    'Privacy Policy for the Cook With Me application and Kitchen Agent mobile service.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brandLink}>
            <span aria-hidden="true">🍳</span>
            <span>Cook With Me</span>
          </Link>
          <Link href="/" className={styles.homeLink}>
            Back to home
          </Link>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.badge}>Official Policy</span>
            <h1 className={styles.title}>Privacy Policy</h1>
            <p className={styles.effectiveDate}>
              Effective Date: October 21, 2026 · Application: Cook With Me (<code>com.freebuff.cookwithme</code>)
            </p>
          </div>

          <div className={styles.content}>
            <section>
              <h2 className={styles.sectionTitle}>1. Overview</h2>
              <p className={styles.paragraph}>
                This Privacy Policy explains how <strong>Cook With Me</strong> (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;)
                collects, uses, and protects your information when you use our web application and mobile application
                (Package ID: <code>com.freebuff.cookwithme</code>). We are committed to protecting your personal data and
                respecting your privacy.
              </p>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>2. Information We Collect and Process</h2>
              <p className={styles.paragraph}>
                We only collect and process data necessary to provide and improve the hands-free cooking and kitchen management experience:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>Account Information:</strong> When you sign in using Firebase Authentication (such as Google Sign-In
                  or email), we collect your name, email address, profile picture (if provided by your identity provider), and a
                  unique user identifier (UID) to authenticate you and sync your data across devices.
                </li>
                <li>
                  <strong>Microphone &amp; Voice Audio:</strong> With your explicit runtime permission, the application accesses
                  your device microphone for hands-free cooking assistance. Audio is streamed in real time to Google Gemini Live
                  using an ephemeral session token minted by our backend (the browser never accesses underlying API keys). Audio
                  streams are processed transiently to interpret cooking instructions and answer hands-free queries. We do not
                  permanently store raw audio recordings or use them for marketing or ad profiling.
                </li>
                <li>
                  <strong>Voice Dictation for Form Fields:</strong> Text fields that offer voice input utilize your device&apos;s
                  native Web Speech Recognition service for client-side transcription.
                </li>
                <li>
                  <strong>Camera &amp; Photo Scans (Fridge &amp; Pantry):</strong> When you choose to scan your fridge or pantry
                  ingredients, photo image data is uploaded to our secure endpoint (<code>/api/vision/scan</code>) and passed to the
                  Google Gemini Vision API as an image payload solely to detect and list food ingredients. Photos are processed in real
                  time and are not stored permanently or shared with third-party advertisers.
                </li>
                <li>
                  <strong>Kitchen &amp; Recipe Content:</strong> Recipes you create or save, pantry inventory items, grocery checklists,
                  leftovers, kitchen timers, and dietary preferences are stored in our secure database (Cloud Firestore) to personalize your experience.
                </li>
                <li>
                  <strong>Device &amp; Usage Information:</strong> Technical data such as device model, operating system version,
                  app version, and error diagnostics may be gathered to diagnose issues, maintain stability, and prevent fraud.
                </li>
              </ul>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>3. How We Use Your Information</h2>
              <p className={styles.paragraph}>
                We use collected information solely for the following operational purposes:
              </p>
              <ul className={styles.list}>
                <li>To authenticate your session and persist your recipes, pantry items, and cooking progress.</li>
                <li>To provide hands-free voice-assisted cooking guidance and interactive step-by-step walkthroughs.</li>
                <li>To detect pantry and fridge ingredients from photos you choose to capture.</li>
                <li>To generate tailored recipe suggestions, substitutions, and kitchen tips based on your dietary preferences.</li>
                <li>To maintain application reliability, prevent abuse, and enforce service quotas.</li>
                <li>To process purchases or subscription entitlements through Google Play Billing (if applicable).</li>
              </ul>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>4. Third-Party Service Providers and Data Transfers</h2>
              <p className={styles.paragraph}>
                We work with reputable cloud infrastructure providers that process data on our behalf under strict confidentiality
                and security standards:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>Google Firebase &amp; Google Cloud Platform:</strong> Provides user authentication, secure database storage
                  (Cloud Firestore), serverless hosting, and security attestation (Firebase App Check).
                </li>
                <li>
                  <strong>Google Gemini AI (Vision &amp; Live Multimodal):</strong> Processes natural language prompts, live voice
                  streams, and uploaded food photos solely to assist with cooking walkthroughs and ingredient extraction.
                </li>
                <li>
                  <strong>Google Play Services:</strong> Manages application distribution, in-app billing verification, and Trusted Web
                  Activity integration on Android devices.
                </li>
              </ul>
              <p className={styles.paragraph}>
                We do not sell, rent, or trade your personal data or media to advertisers or third-party data brokers.
              </p>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>5. Data Security</h2>
              <p className={styles.paragraph}>
                We implement industry-standard administrative and technical safeguards to protect your personal information:
              </p>
              <ul className={styles.list}>
                <li>All data in transit is encrypted using Secure Sockets Layer / Transport Layer Security (HTTPS / TLS 1.3).</li>
                <li>Stored data is protected using AES-256 encryption at rest on Google Cloud infrastructure.</li>
                <li>Access to user data is protected by strict Firebase Security Rules that ensure users can only access their own records.</li>
              </ul>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>6. Data Retention and Account Deletion</h2>
              <p className={styles.paragraph}>
                We retain your information as long as your account remains active or as needed to provide our services. You have the
                right to access, modify, or permanently delete your data at any time:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>Account &amp; Data Deletion:</strong> You can request immediate and permanent deletion of your account,
                  recipes, pantry items, and all associated personal data by emailing us at{' '}
                  <a href="mailto:cherouri@gmail.com" className={styles.link}>
                    cherouri@gmail.com
                  </a>{' '}
                  with the subject &quot;Delete My Account&quot;. All user data is purged within 30 days of request.
                </li>
              </ul>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>7. Children&apos;s Privacy</h2>
              <p className={styles.paragraph}>
                Our application is not directed at children under the age of 13. We do not knowingly collect or solicit personal
                information from children. If you believe a child under 13 has provided us with personal information, please contact
                us immediately and we will delete such information promptly.
              </p>
            </section>

            <section>
              <h2 className={styles.sectionTitle}>8. Changes to This Privacy Policy</h2>
              <p className={styles.paragraph}>
                We may update this Privacy Policy from time to time to reflect changes in our practices, features, or applicable laws.
                Any updates will be posted directly on this page with an updated Effective Date.
              </p>
            </section>

            <section className={styles.footerDivider}>
              <h2 className={styles.sectionTitle}>9. Contact Us</h2>
              <p className={styles.paragraph}>
                If you have questions, feedback, or data privacy requests regarding Cook With Me, please contact:
              </p>
              <div className={styles.contactBox}>
                <p className={styles.contactName}>Laredj Chehrouri (Cook With Me)</p>
                <p className={styles.contactDetail}>
                  Email:{' '}
                  <a href="mailto:cherouri@gmail.com" className={styles.link}>
                    cherouri@gmail.com
                  </a>
                </p>
                <p className={styles.contactSubtext}>Newark, DE 19711, United States</p>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
