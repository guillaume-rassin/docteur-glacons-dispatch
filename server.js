import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function parseEuro(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function htFromTtc55(ttc) {
  return (ttc / 1.055).toFixed(2).replace(".", ",");
}

function toUnixMsLocal(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

function quantityValue(data) {
  return (
    (data.ice20 || 0) * 20 +
    (data.crushed20 || 0) * 20 +
    (data.dryIce2 || 0) * 2 +
    (data.dryIce5 || 0) * 5 +
    (data.dryIce10 || 0) * 10
  );
}

function taskDetails(data) {
  const parts = [];

  if ((data.ice20 || 0) > 0) {
    parts.push(`${data.ice20 * 20} kg de glaçons`);
  }
  if ((data.crushed20 || 0) > 0) {
    parts.push(`${data.crushed20 * 20} kg de pilée`);
  }

  const carboQty = (data.dryIce2 || 0) + (data.dryIce5 || 0) + (data.dryIce10 || 0);
  if (carboQty > 0) {
    parts.push(`${carboQty} produit${carboQty > 1 ? "s" : ""} de carboglace en sticks`);
  }

  if ((data.coolerBox || 0) > 0) {
    parts.push(`${data.coolerBox} bac iso`);
  }

  return parts.join(" + ");
}

function recipientNotes(data) {
  let out = `${data.clientType || ""} - ${data.paymentMethod || ""}`.trim();

  const hasIceOrCrushed = (data.ice20 || 0) > 0 || (data.crushed20 || 0) > 0;
  const feeTtc = parseEuro(data.deliveryFee);

  if ((data.paymentMethod || "").toLowerCase() === "espèces" && hasIceOrCrushed) {
    out += ` contre facture 20 € TTC le sac soit 18,96 € HT`;
  }

  if (feeTtc > 0) {
    out += ` + ${feeTtc} € TTC de frais de livraison soit ${htFromTtc55(feeTtc)} € HT`;
  }

  return out;
}

function validate(data) {
  const errors = [];
  const digits = String(data.phone || "").replace(/\D/g, "");

  if (!data.sendOnfleet) errors.push("La case Onfleet doit être cochée pour créer une course.");
  if (!data.firstName) errors.push("Prénom manquant.");
  if (!data.lastName) errors.push("Nom manquant.");
  if (!data.phone || digits.length < 10) errors.push("Téléphone invalide.");
  if (!data.clientType) errors.push("Typologie de client manquante.");
  if (!data.address) errors.push("Adresse manquante.");
  if (!data.deliveryDate) errors.push("Date manquante.");
  if (!data.timeMin) errors.push("Heure min manquante.");
  if (!data.timeMax) errors.push("Heure max manquante.");
  if (!data.paymentMethod) errors.push("Mode de règlement manquant.");

  const qty = quantityValue(data);
  if (qty <= 0 && (data.coolerBox || 0) <= 0) errors.push("Aucun produit sélectionné.");

  return errors;
}

app.post("/api/create-onfleet-task", async (req, res) => {
  try {
    const data = req.body || {};
    const errors = validate(data);
    if (errors.length) return res.status(400).json({ ok: false, error: errors.join(" ") });

    const apiKey = process.env.ONFLEET_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "clé API manquante" });

    const auth = Buffer.from(`${apiKey}:`).toString("base64");

    const payload = {
      recipients: [
        {
          name: data.firstName || "",
          phone: data.phone || "",
          notes: recipientNotes(data)
        }
      ],
      destination: {
        address: {
          unparsed: data.address,
          apartment: data.venueName || ""
        },
        notes: data.instructions || ""
      },
      completeAfter: toUnixMsLocal(data.deliveryDate, data.timeMin),
      completeBefore: toUnixMsLocal(data.deliveryDate, data.timeMax),
      notes: taskDetails(data),
      quantity: quantityValue(data)
    };

    const response = await fetch("https://onfleet.com/api/v2/tasks", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: result.message || "Erreur Onfleet",
        payload,
        onfleet: result
      });
    }

    res.json({
      ok: true,
      taskId: result.id,
      shortId: result.shortId || null,
      trackingURL: result.trackingURL || null,
      payloadSent: payload,
      onfleet: result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Erreur serveur"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
