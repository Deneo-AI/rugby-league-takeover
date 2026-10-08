import React from "react";
import LegalPage from "@/components/public/LegalPage";

const FALLBACK = `Effective date: 28 July 2026

These Terms & Conditions apply when you use the Rugby League Takeover ("RLT", "we", "us") website or app, create an account, participate in the fan community, register interest in travel or events, or buy merchandise. By using the service you agree to these terms. You must be at least 18 years old.

[Accounts and acceptable use]
Provide accurate information, keep your login secure and tell us promptly if you suspect unauthorised access. You must not misuse the service, interfere with its operation, impersonate others, evade moderation or security controls, scrape or automate access without permission, or use the service for unlawful, abusive, deceptive or infringing activity.
We may restrict, suspend or end access where reasonably necessary to protect users, enforce these terms, investigate abuse or comply with law. You may delete your account through /delete-account.

[Community content and moderation]
You retain ownership of content you submit. You give RLT a non-exclusive, worldwide, royalty-free licence to host, store, reproduce, display and adapt that content only as needed to operate, moderate and promote the service.
Do not post content that is unlawful, threatening, hateful, defamatory, sexually exploitative, privacy-invasive, misleading, spam, or that infringes another person's rights. Public posts and profile information you choose to display can be seen and shared by others. We may edit, hide, remove, preserve or report content and may act on reports, but we do not promise to review every contribution. Opinions posted by users are their own.

[Fan rewards, tipping and games]
Badges, points, chips, streaks, tips and similar features are for entertainment and community recognition only. They have no cash value, cannot be redeemed or transferred, and are not gambling, wagering or a promise of prizes. We may correct errors, reverse abuse, adjust rules or retire a feature where reasonably required.

[Merchandise, pricing and payment]
Store prices and charges are displayed in Australian dollars. The checkout shows the merchandise total, applicable GST, card fee, discount and shipping before payment. Payment is processed by Stripe. An order is accepted after successful payment and confirmation, subject to stock and fraud checks. If we cannot supply an item, we will offer an appropriate refund or other remedy.
Australian delivery is charged at the fixed rate displayed in the cart or at the current Australia Post service rate calculated for the delivery postcode, depending on the shipping mode shown at checkout. Standard delivery is free when the merchandise subtotal is at least $150, unless a clearly disclosed promotion or collection option applies. Delivery dates are estimates. You are responsible for providing a complete and accurate delivery address.

[Returns and Australian Consumer Law]
For change-of-mind returns, contact support@rugbyleaguetakeover.com within 30 days after delivery. Items must be unworn, unused and in resalable condition with original packaging where reasonably possible. Original delivery charges and return postage are not refundable for change of mind unless we agree otherwise.
Our products come with consumer guarantees that cannot be excluded under the Australian Consumer Law. Change-of-mind conditions do not limit your rights where goods are faulty, unsafe, incorrectly described or otherwise fail a consumer guarantee. Contact us and we will provide the remedy required by law.

[Travel, tickets and third parties]
Travel packages, accommodation, tickets, venues and event offers may be supplied or booked through third parties. Availability, pricing, deposits, changes, cancellations and fulfilment may be governed by the provider's terms. Unless RLT expressly states it is the contracting provider, your contract is with that third party. Review their terms, travel advice, insurance and entry requirements before paying or travelling.
Links, sponsors and advertisements do not amount to an endorsement or guarantee. Third-party sites and services have their own terms and privacy practices.

[Intellectual property]
RLT branding, site design and original content are owned by or licensed to us. Except for normal personal use, you must not reproduce, sell, modify or exploit them without permission. Rugby league club, competition, venue and sponsor marks belong to their respective owners.

[Service availability and liability]
We aim to keep the service accurate and available but do not guarantee uninterrupted access, that user content is correct, or that every event, offer or feature will proceed. To the maximum extent permitted by law, we are not liable for indirect or consequential loss that was not reasonably foreseeable. Nothing in these terms excludes, restricts or modifies a right or remedy that cannot lawfully be excluded, including Australian Consumer Law rights.

[Changes and contact]
We may update these terms where the service, risks or legal requirements change. Material changes apply prospectively after the updated terms are posted. If you do not agree, stop using the service and delete your account.
Questions, returns and complaints can be sent to support@rugbyleaguetakeover.com.`;

export default function Terms() {
  return <LegalPage settingsKey="legal_terms" title="Terms & Conditions" fallback={FALLBACK} />;
}
