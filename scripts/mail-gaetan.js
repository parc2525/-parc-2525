// Mail quotidien "départs" pour Gaëtan — Parc 2525
// Lit les données Firebase (lecture publique, aucune authentification nécessaire),
// calcule les départs à J (aujourd'hui / en retard), J-1 et J-2 ouvrés,
// et envoie un mail récapitulatif via l'API Brevo.
//
// Déclenché par GitHub Actions (voir .github/workflows/mail-gaetan.yml).
// Ne fait rien (exit sans envoi) : le week-end, ou si l'heure locale Paris
// n'est pas proche de 8h30 (garde-fou contre le double déclenchement été/hiver).

const FIREBASE_URL = "https://parc-2525-default-rtdb.europe-west1.firebasedatabase.app/parc2525.json";
const DEST_TO = "gaetan.chalon@stellantis.com";
const DEST_CC = "bourama.sangare@stellantis.com";
const TARGET_HOUR_PARIS = 8;
const TARGET_MINUTE_PARIS = 30;
const TOLERANCE_MINUTES = 20; // fenêtre d'exécution autour de 8h30, pour absorber les deux cron (été/hiver) + latence GitHub

function parisParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday, // "Mon","Tue",...
  };
}

function isWeekendISO(iso) {
  const d = new Date(iso + "T12:00:00Z"); // midi UTC pour éviter tout glissement de jour
  const day = d.getUTCDay(); // 0=dimanche,6=samedi
  return day === 0 || day === 6;
}

function addBusinessDaysISO(iso, n) {
  let d = new Date(iso + "T12:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function frDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

async function main() {
  const now = new Date();
  const paris = parisParts(now);
  const forceSend = String(process.env.FORCE_SEND).toLowerCase() === "true";

  if (!forceSend && (paris.weekday === "Sat" || paris.weekday === "Sun")) {
    console.log(`Week-end (${paris.weekday}) à Paris — pas d'envoi.`);
    return;
  }

  const minutesNow = paris.hour * 60 + paris.minute;
  const minutesTarget = TARGET_HOUR_PARIS * 60 + TARGET_MINUTE_PARIS;
  if (!forceSend && Math.abs(minutesNow - minutesTarget) > TOLERANCE_MINUTES) {
    console.log(`Hors fenêtre d'envoi (il est ${paris.hour}h${String(paris.minute).padStart(2,"0")} à Paris, cible 8h30 ±${TOLERANCE_MINUTES}min) — pas d'envoi.`);
    return;
  }
  if (forceSend) console.log("FORCE_SEND actif — envoi immédiat, sans tenir compte du jour/de l'heure.");

  console.log(`Envoi du mail quotidien — ${paris.iso} ${paris.hour}h${String(paris.minute).padStart(2,"0")} (Paris)`);

  const res = await fetch(FIREBASE_URL);
  if (!res.ok) throw new Error(`Lecture Firebase échouée : HTTP ${res.status}`);
  const raw = await res.json();
  if (!raw) throw new Error("Réponse Firebase vide.");

  const vhl = JSON.parse(raw.vhl || "[]");
  const prets = JSON.parse(raw.prets || "{}");

  const today = paris.iso;
  const j1 = addBusinessDaysISO(today, 1);
  const j2 = addBusinessDaysISO(today, 2);

  const enRetard = [], aujourdhui = [], demain = [], dans2joursOuvres = [];

  Object.entries(prets).forEach(([vid, vp]) => {
    (vp || []).forEach(pr => {
      if (pr.departConfirme) return; // déjà géré par Gaëtan, pas la peine de le relister
      const v = vhl.find(x => x.id === vid);
      const item = {
        immat: vid,
        modele: v ? v.modele : "",
        parc: v ? v.parc : "",
        personne: pr.personne || "",
        heureDepart: pr.heureDepart || "",
        debut: pr.debut,
      };
      if (pr.debut < today) enRetard.push(item);
      else if (pr.debut === today) aujourdhui.push(item);
      else if (pr.debut === j1) demain.push(item);
      else if (pr.debut === j2) dans2joursOuvres.push(item);
    });
  });

  [enRetard, aujourdhui, demain, dans2joursOuvres].forEach(l => l.sort((a, b) => a.debut.localeCompare(b.debut)));

  function section(titre, emoji, items, { showDate } = {}) {
    if (items.length === 0) {
      return `<h3 style="margin:18px 0 6px;font-size:14px;color:#334155;">${emoji} ${titre}</h3><p style="margin:0 0 10px;color:#94a3b8;font-size:13px;">Aucun.</p>`;
    }
    const rows = items.map(it => {
      const heure = it.heureDepart ? ` à ${it.heureDepart}` : "";
      const date = showDate ? ` — prévu le ${frDate(it.debut)}` : "";
      return `<li style="margin-bottom:4px;"><strong>${it.immat}</strong> ${it.modele || ""} (parc ${it.parc || "?"}) — ${it.personne || "sans nom"}${heure}${date}</li>`;
    }).join("");
    return `<h3 style="margin:18px 0 6px;font-size:14px;color:#0c1a2e;">${emoji} ${titre} (${items.length})</h3><ul style="margin:0 0 10px;padding-left:20px;font-size:13px;color:#1e293b;">${rows}</ul>`;
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;">
      <div style="background:linear-gradient(135deg,#0c1a2e,#1a3a5c);padding:16px 18px;border-radius:8px 8px 0 0;">
        <div style="color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Parc 2525</div>
        <div style="color:#fff;font-size:18px;font-weight:800;">Départs à préparer</div>
        <div style="color:#cbd5e1;font-size:12px;margin-top:2px;">${frDate(today)}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 18px;">
        ${section("En retard (départ non confirmé, date dépassée)", "🚨", enRetard, { showDate: true })}
        ${section("Aujourd'hui", "🚀", aujourdhui)}
        ${section("Demain", "⏭️", demain)}
        ${section("Dans 2 jours ouvrés", "🗓️", dans2joursOuvres, { showDate: true })}
        <p style="margin-top:20px;font-size:11px;color:#94a3b8;">Mail automatique quotidien (jours ouvrés, 8h30) — Parc 2525.</p>
      </div>
    </div>`;

  const totalCount = enRetard.length + aujourdhui.length + demain.length + dans2joursOuvres.length;
  const subject = totalCount > 0
    ? `🚗 Parc 2525 — ${totalCount} départ(s) à préparer — ${frDate(today)}`
    : `🚗 Parc 2525 — aucun départ à préparer — ${frDate(today)}`;

  const apiKey = process.env.BREVO_API_KEY;
  const mailFrom = process.env.MAIL_FROM;
  if (!apiKey) throw new Error("Secret BREVO_API_KEY manquant.");
  if (!mailFrom) throw new Error("Secret MAIL_FROM manquant.");

  const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      sender: { email: mailFrom, name: "Parc 2525" },
      to: [{ email: DEST_TO }],
      cc: [{ email: DEST_CC }],
      subject,
      htmlContent: html,
    }),
  });

  if (!brevoRes.ok) {
    const body = await brevoRes.text();
    throw new Error(`Échec d'envoi Brevo : HTTP ${brevoRes.status} — ${body}`);
  }
  console.log("Mail envoyé avec succès.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
