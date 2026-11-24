# Architecture du client web

Pour s'orienter dans `web/`. Le *pourquoi* : `docs/adr/` ; le fil : `docs/protocol/` ; les conventions : `AGENTS.md`.

## 1. Règle

**Rien du document ne quitte l'appareil en clair** (E2E strict, ADR-0002). Tout contenu (texte, annotations, décisions, présence, historique, trousseau) est chiffré en AES-256-GCM par une clé que le serveur ne voit jamais. Le serveur reçoit des blobs, plus des métadonnées dont la liste est fermée (§3).

## 2. Deux étages

- **`lib/`** : bibliothèque cliente de référence (protocole, crypto, transport, annotations, décisions, présence, trousseau, signatures). Elle n'importe que `loro-crdt`, et la page ne l'atteint que par `lib/src/index.ts` (`lib/src/boundary.test.ts`).
- **`src/`** : la page. Éditeur CodeMirror, liaison CRDT (`crdt-binding/`), vues Svelte (`ui/`), rendu (`render/`), stockage local (`storage/`), « Mes documents » (`keyring/`), compte (`account/`), service worker (`sw/`). Point d'entrée : `startPage(env)` (`app/page.ts`) ; `main.ts` ne fait que construire `env` depuis le navigateur.

## 3. Les clés, et où elles vont

| Secret | Vit dans | Part vers le serveur ? |
|---|---|---|
| Clé de contenu `k` | fragment du lien (`#k=…`) | jamais |
| Secret de rôle `r` | fragment du lien | oui, à l'authentification seulement |
| Empreintes des rôles | calculées par le client | oui, à la création et à la rotation |
| Clé du trousseau `K_t` | lien `oc-keyring:v1:…`, appareil | jamais |
| Secret d'accès du trousseau `S` | même lien | oui, pour s'authentifier |
| Clé de signature Ed25519 | IndexedDB, non extractible | jamais (la clé publique, oui) |
| Clé éphémère d'une notification (P-256) | mémoire, le temps d'un chiffrement | jamais (la clé publique, oui, dans le message chiffré) |

Le fragment d'une URL n'est jamais envoyé par le navigateur : c'est ce qui sépare la clé du serveur (`lib/src/crypto/link-fragment.ts`). Les secrets de lecture et de suggestion sont dérivés du secret d'édition par HKDF, à sens unique (`lib/src/crypto/role-secrets.ts`).

**En clair sur le WebSocket**, et rien d'autre (les sorties HTTP sont listées au §4) : identifiant du document, rôle, secret de rôle (à l'authentification), empreintes, nom de canal, `seq`, `up_to_seq` d'une compaction, échéance. Plus les métadonnées qu'aucun chiffrement ne cache : tailles, rythmes, IP, nombre de participants (`docs/security/threat-model.md`).

## 4. Comment on le voit dans le code

**Un seul chiffrement par sortie.** Chaque octet de contenu passe par l'une de deux fonctions pures, « octets en entrée, octets en sortie » :

- `encrypt`/`decrypt` (`lib/src/crypto/aead.ts`) : nonce aléatoire de 12 octets en tête, AES-GCM de WebCrypto ;
- `encryptKeyring`/`decryptKeyring` (`lib/src/keyring/crypto.ts`) : la même chose pour un trousseau ;
- `encryptAttachment`/`decryptAttachment` (`lib/src/attachments/crypto.ts`) : `encrypt` avec, en données associées, le document et l'image (K-19) ; `prepareImage` (`image.ts`) retire avant les métadonnées (`metadata.ts`) ;
- `encryptNotification` (`lib/src/push/encrypt.ts`) : RFC 8291 pour un abonnement (K-20), jamais la clé de contenu ; le service de push ne lit rien, le navigateur destinataire déchiffre.

**Une seule sortie WebSocket**, `connectDocument` (`lib/src/transport/client.ts`). Les trames de contenu y sont toutes construites par `encodeFrame(canal, blob)`, juste après `encrypt` :

- `trySend` : publication sur `content`, `annotations`, `decisions` ;
- `triggerCompaction` : instantané complet, chiffré avant `encodeCompactMessage` ;
- `publishPresence` : la présence aussi (ADR-0025).

Les autres messages (`encodeAuthMessage`, `encodeRotateMessage`, `encodeDeleteMessage`, `encodeExpireMessage`, `encodeJoinMessage`, `lib/src/transport/protocol.ts`) ne portent que les champs en clair du §3, et leurs types n'acceptent pas de contenu.

**Les sorties HTTP passent par `env.fetch`** (`PageEnvironment`), jamais par `fetch` directement, hors `main.ts` et le service worker :

- `POST /documents` (`lib/src/links/links.ts`) : identifiant et empreintes ;
- trousseau (`lib/src/keyring/sync.ts`, `http.ts`) : blob `encryptKeyring(K_t, …)`, `S` dans l'en-tête `Keyring-Secret` ;
- appariement d'un appareil (`lib/src/keyring/pairing.ts`) : dépôt chiffré par une clé passée hors ligne (QR) ;
- passerelle (`src/account/`, `lib/src/keyring/account.ts`) : jeton, clé publique, trousseau de compte chiffré par `K_t` ;
- `GET /revocations` : liste publique, signée par la passerelle ;
- `GET /config.json` (`src/account/config.ts`) : rien ; la page y lit la passerelle, les empreintes d'attestation et la clé VAPID, le plugin la seule clé VAPID (OB3) ;
- image jointe (`lib/src/attachments/http.ts`) : blob `encryptAttachment`, le secret du rôle dans `Role-Secret` (ADR-0057) ;
- notification (`lib/src/push/http.ts`, `POST /documents/<id>/push`, ADR-0060) : en clair l'`endpoint` de l'abonnement et le `ttl` ; le message `encryptNotification` ; le secret du rôle dans `Role-Secret`. Envoyée par `src/push/notifier.ts`, une fois la réponse acquittée ou le rejet gagnant.

**Une image distante**, seule sortie vers un tiers (ADR-0055), n'est demandée que par le navigateur, sur l'accord du lecteur (`src/view-model/remote-images.ts`, local à l'appareil, `REMOTE_IMAGES_KEY`) : le rendu n'émet une `<img>` distante que pour une adresse accordée que `loadableImageSource` admet (`src/render/remote-image.ts`), avec `referrerpolicy="no-referrer"` ; l'éditeur, de même (`src/editor/remote-image-grants.ts`). Aucun octet du document n'y part, sinon l'adresse écrite dans le texte.

**Une image jointe** (ADR-0057) se télécharge sous le secret du rôle (`src/ui/images/attached-image-sources.ts`), se déchiffre sous le document et l'image, et s'affiche par une adresse à elle : `data:` pour un SVG, jamais `blob:`, qui a l'origine de la page (§7) ; `blob:` typée d'après ses octets sinon, révoquée à la fermeture de la vue (`src/view-model/attached-images.ts`). Le rendu n'émet qu'un emplacement (`data-attachment`), que l'aperçu et l'éditeur remplissent.

**Sur l'appareil**, la copie locale (IndexedDB) est chiffrée par la clé de contenu (`src/storage/local-store.ts`, ADR-0022), celle des images jointes l'est déjà (leur blob, `src/storage/image-cache.ts`), et la copie du trousseau par `K_t` (`src/keyring/local.ts`). La tournée de « Mes documents » (`src/keyring/awaiting-count.ts`, ADR-0060 §2) lit une copie sans son verrou (`peekLocalRecord`) et ne l'écrit jamais ; sa connexion ne publie rien (`readOnlyResume`). Exceptions connues, écrites dans le modèle de menace (point 18) : la clé de la liste et le jeton de la passerelle y sont en clair dans la page ; dans le plugin, ils sont scellés par une clé de l'appareil (`sealKey`).

**Une notification du système** (ADR-0060 §1), seule sortie en clair vers l'appareil hors de la page, sur l'accord du lecteur (la permission du navigateur, demandée d'un clic) : le titre du document, un nom et le début d'une entrée, que le centre de notifications garde (`src/ui/alerts/alerts.ts`, par `env.attention`, `src/app/browser-attention.ts`). Le titre de l'onglet ne porte que le compte de ce qui attend ma réponse, jamais celui du document : il irait dans l'historique du navigateur.

**Le service worker** (`src/sw/`) ne met en cache que les fichiers de la page, `config.json` et la liste publique des révocations (`src/sw/strategy.ts`) : jamais un document ni un trousseau. Il montre, en texte brut, une notification poussée (`src/sw/push.ts`, D-43) ; un clic n'ouvre que `?doc=` sur l'origine de la page, jamais une adresse du message.

**L'abonnement de l'appareil** (ADR-0060 §4, `src/push/device.ts`) est écrit dans le document, signé, donc chiffré comme lui : lisible de tout détenteur d'un lien. L'appareil garde, en clair dans `localStorage` (`PUSH_ENDPOINTS_KEY`), les `endpoint` qu'il a écrits, pour reconnaître ses entrées (O-40). L'invitation à être prévenu (phase 34j, `src/ui/alerts/alerts-invite.ts`) y garde les identifiants des 100 derniers documents où elle a eu sa réponse (`NOTIFY_INVITES_KEY`). La première visite (ADR-0064, `src/ui/writing/hints.ts`) y garde les noms des bandeaux et bulles déjà vus (`HINTS_KEY`), aucun identifiant de document.

## 5. Ce qui le vérifie

- `src/e2e/real-server.e2e.test.ts` : un espion sur le WebSocket du vrai serveur vérifie qu'aucune trame ne contient le texte tapé.
- `lib/src/crypto/aead.property.test.ts`, `lib/src/keyring/crypto.property.test.ts` : aller-retour, et aucune exception sur des entrées arbitraires.
- `*.vectors.test.ts` : vecteurs de `docs/protocol/vectors.json` (chiffrement, liens, trousseau, images) ; `lib/src/attachments/*.property.test.ts` : métadonnées retirées, rien d'autre ; une image n'ouvre que sous ses identifiants ; `src/e2e/*-interop.e2e.test.ts` : interopérabilité avec `independent-client/`.
- `lib/src/boundary.test.ts` : la bibliothèque n'importe que `loro-crdt` ; la page n'atteint que son entrée.
- `src/render/render.property.test.ts` : aucune `<img>` distante sans accord, hors `https:` admis, ou avec un référent, et un emplacement d'image jointe n'a qu'un identifiant de W-53 ; `src/view-model/attached-images.property.test.ts` : chaque attente d'une image dans un ordre tiré, la vue fermée à tout moment, aucune adresse qui survit ; `src/ui/images/attached-image-sources.test.ts` : un SVG jamais en `blob:` ; `src/ui/reading/preview-async-order.property.test.ts` : rien de chargé une première fois sous un curseur ; `npm run check:ui` : sous la vraie CSP, rien de demandé avant l'accord, puis sans `Referer` ; `src/ui/alerts/alerts.test.ts`, `src/ui/alerts/alerts-async-order.property.test.ts` : rien de notifié avant l'ouverture, regardé, ni après la fermeture ; `src/ui/alerts/alerts-invite-async-order.property.test.ts` : la permission demandée dans le geste seulement ; `lib/src/push/*.test.ts` : RFC 8291 contre un déchiffreur écrit d'après la RFC, destinataires de D-44 ; `src/push/notifier.property.test.ts` : chaque envoi vers un destinataire seulement, une fois, après l'acquittement ou la décision, jamais après la fermeture ; `src/push/device.property.test.ts` : chaque entrée entière, celle d'un autre jamais retirée, une seule pour l'appareil à l'ouverture ; `src/sw/push.test.ts` : du texte, un clic vers `?doc=` seulement.

Ajouter une sortie (un `send`, un `fetch`, un champ de message) : son contenu passe par `encrypt`/`encryptKeyring`, sinon le champ s'ajoute à la liste en clair du §3 et à la spécification (`docs/protocol/`), dans le même commit.
