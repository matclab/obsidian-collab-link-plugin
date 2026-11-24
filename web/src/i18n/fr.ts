import type { Dictionary } from "./en.js";
import { pluralFor } from "./plural.js";

const plural = pluralFor("fr");

/** Every text the page shows, in French: the same keys as English, which
 * the compiler checks (`satisfies`). */
export const fr = {
  // ------------------------------------------------------------ page
  refusedUnauthenticated: "Lien invalide ou révoqué, ou document supprimé.",
  refusedDeleted:
    "Ce document a été supprimé du serveur. Ce que vous voyez est la copie gardée dans ce navigateur, à lire et à copier.",
  refusedRevoked: "Ce lien a été révoqué : demandez le nouveau à un éditeur.",
  refusedForbidden: "Accès refusé.",
  refusedVersion:
    "Le serveur a été mis à jour et parle une autre version du protocole : rechargez la page.",
  refusedOther: (code) => `Le serveur a fermé la connexion (${code}).`,
  refusedWithUnsent: (refusal) =>
    `${refusal} Les modifications pas encore envoyées sont gardées dans ce navigateur : ouvrez le nouveau lien pour les envoyer.`,
  localOtherTab:
    "Ce document est ouvert dans un autre onglet : ce que cet onglet n'a pas envoyé est perdu à sa fermeture.",
  localUnreadable:
    "Une copie locale de ce document ne peut pas être lue ici : elle est laissée telle quelle, et cet onglet ne garde rien sur cet appareil.",
  localUnavailable:
    "Ce navigateur ne garde rien sur cet appareil : ce qui n'est pas envoyé est perdu à la fermeture de l'onglet.",
  unsentTitle:
    "Gardées dans ce navigateur seulement jusqu'à leur envoi. Une fenêtre de navigation privée les perd à sa fermeture.",
  invalidEntries: (count) =>
    `${count} ${plural(count, { one: "entrée illisible ignorée", other: "entrées illisibles ignorées" })}`,
  invalidLink:
    "Lien invalide : il ne contient pas de clé ou pas de secret de rôle.",
  pastedLinkConverted:
    "Lien collé sans sa clé : seules les personnes qui ont déjà ce document pourront l'ouvrir depuis le texte. Le lien complet est gardé dans vos documents. « Coller avec la clé » donne l'accès à tous les lecteurs de ce texte.",
  pastedLinkNotKept:
    "Lien collé sans sa clé : seules les personnes qui ont déjà ce document pourront l'ouvrir depuis le texte. Ce navigateur ne garde pas vos documents : conservez le lien ailleurs. « Coller avec la clé » donne l'accès à tous les lecteurs de ce texte.",
  keepFullLink: "Coller avec la clé",
  pastedLinkGone:
    "Le texte collé a changé depuis : collez à nouveau le lien pour le remettre avec sa clé.",
  keylessAbsent:
    "Cette adresse désigne un document qui n'est pas dans vos documents : demandez son lien à qui vous l'a donnée.",
  keylessUnchecked:
    "Cette adresse désigne un document absent de la copie de vos documents sur cet appareil, et la liste n'a pas pu être vérifiée : réessayez une fois en ligne.",
  keylessNoList:
    "Cette adresse désigne un document sans sa clé, et ce navigateur ne garde pas la liste de vos documents : demandez son lien, ou ouvrez votre liste ici.",
  createNeedsServer:
    "Créer un document demande le serveur : il est injoignable.",
  internalError:
    "Erreur interne : rechargez la page. Ce qui n'a pas été envoyé est gardé dans ce navigateur. Si l'erreur revient après rechargement, ce document contient une entrée que cette version ne sait pas lire.",
  saveFailed:
    "L'enregistrement sur cet appareil a échoué : ce qui n'est pas envoyé est perdu à la fermeture de l'onglet.",
  cannotRenew:
    "Impossible de renouveler les liens : ce navigateur ne garde aucun stockage local.",
  downloadTrace: "Télécharger la trace",

  close: "Fermer",
  documentText: "Texte du document",
  startWriting:
    "Commencez à écrire ici. Tapez / pour un titre, une liste, un tableau… ; le ? de la barre explique le reste. Un premier titre donne son nom au document.",
  emptyDocument: "Ce document est vide.",
  untitled: "Document sans titre",
  syncSaved: "Enregistré",
  syncSavedTitle: "Le serveur a toutes les modifications faites ici.",
  syncSending: "Envoi…",
  syncOffline: "Hors ligne — gardé sur cet appareil",

  // ------------------------------------------------------------ name
  chooseName: "Votre nom",
  continue: "Continuer",
  dismiss: "Fermer ce message",
  reload: "Recharger",
  choosePseudonym:
    "Choisissez un nom affiché sur vos commentaires et suggestions :",
  anonymous: "anonyme",
  yourName: "Votre nom",
  save: "Enregistrer",
  cancel: "Annuler",
  nameLength: "Un nom a de 1 à 200 caractères.",
  nameOfIdentity:
    "Le nom de votre identité, tant que vous êtes identifié. Déconnecté, ce navigateur reprend son propre nom.",
  nameNote:
    "Un nom affiché, non vérifié : chacun peut choisir n'importe quel nom. Les nouveaux commentaires et suggestions le portent ; les précédents gardent le leur.",

  // ------------------------------------------------------------ presence
  nobodyElse: "Personne d'autre ici.",
  hereNow: "Ici en ce moment :",
  namesNotVerified: "Noms choisis par chacun, non vérifiés.",

  // ------------------------------------------------------------ mes documents
  homeTitle: "Documents collaboratifs",
  newDocument: "Nouveau document",
  myDocuments: "Mes documents",
  myDocumentsIntro:
    "Gardez la liste des documents que vous ouvrez, sur tous vos appareils : pas de compte, une clé que vous seul détenez.",
  keepMyDocuments: "Garder mes documents",
  findMyDocuments: "Retrouver mes documents",
  findMyDocumentsIntro:
    "Sur un autre appareil, collez votre clé de Mes documents : la liste s'y ouvre aussi.",
  myDocumentsKey: "Clé de Mes documents",
  openList: "Ouvrir",
  keyInvalid: "Ce n'est pas une clé de Mes documents.",
  keyNotFound: "Aucune liste ne correspond à cette clé sur ce serveur.",
  keyUnreadable: "Cette clé n'ouvre pas la liste gardée sur ce serveur.",
  keyRevealTitle: "Votre clé de Mes documents",
  keyRevealNote:
    "Gardez-la dans un gestionnaire de mots de passe : elle ouvre tous les documents de la liste. Ne la partagez jamais, ne l'envoyez jamais.",
  keyKept: "Je l'ai gardée",
  showKey: "Afficher la clé de Mes documents",
  noDocumentsYet:
    "Aucun document pour l'instant : les documents que vous ouvrez s'afficheront ici.",
  filterList: "Filtrer",
  sortBy: "Trier par",
  sortRecent: "Dernière ouverture",
  sortTitle: "Titre",
  openedOn: (date: string) => `Ouvert le ${date}`,
  stateRenewed: "Lien renouvelé : demandez le nouveau, puis collez-le ici.",
  stateDeleted: "Supprimé du serveur.",
  newLink: "Nouveau lien",
  linkNotThisDocument: "Ce lien n'est pas celui de ce document.",
  saveLink: "Garder",
  removeFromList: "Retirer",
  removeConfirm:
    "Retirer ce document de Mes documents ? Rouvrir son lien ne l'y remettra pas.",
  keyringOffline:
    "Le serveur est injoignable : la liste affichée est celle gardée sur cet appareil.",
  keyringGone:
    "Cette liste n'existe plus sur le serveur. Sa copie sur cet appareil est gardée.",
  keyringRecreate: "La garder sous une nouvelle clé",
  keyringFull:
    "Mes documents est plein : retirez des documents pour en garder de nouveaux.",
  keyringUnreadableServer:
    "La liste gardée sur le serveur ne se lit pas avec cette clé : la copie sur cet appareil est gardée.",
  keyringSuperseded:
    "Un autre onglet a ouvert une autre liste sur cet appareil : rechargez la page.",
  keyringUnavailable:
    "Ce navigateur ne garde rien sur cet appareil : Mes documents n'y est pas disponible.",
  keyringRotationHeld:
    "Les liens n'ont pas été renouvelés : le nouveau lien n'a pas pu être gardé dans Mes documents.",
  changeKey: "Changer la clé",
  changeKeyConfirm:
    "Changer la clé de Mes documents ? La clé actuelle n'ouvrira plus la liste : sur vos autres appareils, vous collerez la nouvelle.",
  keyChanged:
    "Clé changée. Sur vos autres appareils, collez cette nouvelle clé quand ils la demandent.",
  oldKeyStillOpens:
    "L'ancienne clé n'a pas encore pu être révoquée : elle ouvre la liste jusqu'à ce que cet appareil joigne de nouveau le serveur.",
  keyringGoneNewKey:
    "Si vous avez changé sa clé sur un autre appareil, collez la nouvelle clé : la copie de cet appareil la rejoint.",
  keyringUnsaved:
    "Cet appareil n'a pas pu garder la liste : il réessaiera à la prochaine synchronisation.",
  signInReturnDone:
    "Identification transmise à la page : vous pouvez fermer cette fenêtre.",
  signInReturnNothing: "Cette page ne sert qu'au retour d'une identification.",
  signIn: "S'identifier",
  signInPending: "Identification en cours…",
  signInCancel: "Annuler",
  signToNameTitle: "Vous identifier pour signer de votre nom ?",
  signToNameBody:
    "Ce que vous écrivez est signé par la clé de cet appareil. Identifié, il porte aussi le nom que votre organisation vous donne, que les autres peuvent vérifier.",
  signToNameSignedInTitle: "Signer de votre nom ?",
  signToNameConfirmBody:
    "Votre identité doit être confirmée pour que ce que vous écrivez porte votre nom, vérifié. La fenêtre de connexion vous redemandera votre mot de passe.",
  signToNameSignIn: "S'identifier",
  signToNameWithout: "Continuer sans",
  identityLabel: (org, who) =>
    `${org ? `Identité ${org}` : "Identité"} : ${who}`,
  signOut: "Se déconnecter",
  signInDenied: "Identification refusée.",
  signInFailed: "L'identification a échoué : réessayez.",
  signInExpired: "Votre session a expiré : identifiez-vous de nouveau.",
  signInWindowNote:
    "Une fenêtre s'ouvre sur la page de connexion de votre organisation. Si rien ne s'ouvre, autorisez les fenêtres surgissantes pour ce site.",
  // ------------------------------------------------------------ identité
  identityOf: (org) => (org ? `Identité ${org}` : "Identité"),
  identityWho: (name, email) => (email ? `${name} (${email})` : name),
  yourIdentity: (org, who) => `votre identité ${org ? `${org}, ` : ""}${who}`,
  associatedFuture: (identity) =>
    `Les documents que vous créez ou ouvrez dans ce navigateur seront associés à ${identity}.`,
  associateQuestion: (count, identity) =>
    `Associer ${plural(count, { one: "ce document", other: `ces ${count} documents` })} à ${identity} ?`,
  associateMore: (count) =>
    `et ${count} ${plural(count, { one: "autre", other: "autres" })}`,
  associate: "Associer",
  otherIdentityQuestion: (count, other, identity) =>
    `Ce navigateur garde ${count} ${plural(count, { one: "document", other: "documents" })} d'une autre identité${other ? ` (${other})` : ""}, identifiée ici auparavant. ${plural(count, { one: "L'associer", other: "Les associer" })} à ${identity} ?`,
  associateOther: "Associer à votre identité",
  identityChooseHome: "Choisir quoi en faire, à l'accueil",
  forgetOther: "Ne pas les garder ici",
  forgetOtherNote:
    "Non gardés ici, ils restent dans la liste de l'autre identité, qui les retrouve en s'identifiant.",
  cursorVerified: (name) => `${name} (nom vérifié)`,
  cursorNotVerified: (name) => `${name} (nom non vérifié)`,
  identityAttested: "Ce que vous écrivez porte votre nom.",
  identityNotYet: "Ce que vous écrivez ne porte pas encore votre nom :",
  identityAssociate: "associez les documents de ce navigateur à votre identité",
  identityOpenHere:
    "ouvrez votre liste de documents sur ce navigateur, une fois : depuis un appareil où elle est ouverte, ou avec sa clé",
  identityConfirm: "Confirmer votre identité",
  identityInMenu: "Voir l'identité dans le menu Document.",
  identityRefused:
    "Votre organisation n'atteste plus la clé de ce navigateur : ce que vous écrivez ne porte pas votre nom.",
  newSigningKey: "Nouvelle clé de signature",
  newSigningKeyExplains:
    "Ce que vous écrirez ensuite portera de nouveau votre nom. Ce que l'ancienne clé a signé reste tel quel.",
  newSigningKeyOffline:
    "Hors ligne : votre liste n'a pas pu se synchroniser. Réessayez une fois en ligne.",
  identityChipNewKey: "Clé refusée · Nouvelle clé",
  identityOther:
    "La liste de ce navigateur appartient à une autre identité : ce que vous écrivez ne porte pas votre nom.",
  identityUnconfirmed:
    "Votre identité n'a pas pu être confirmée auprès de la passerelle : ce que vous écrivez ne porte pas encore votre nom.",
  identityRetry: "Réessayer",
  identityChipRetry: "Identité non confirmée · Réessayer",
  identityChipCancel: "Identification en cours… · Annuler",
  identityChipAssociate: "Vos documents à associer",
  identityChipOpenHere: "Ouvrir votre liste ici",
  identityChipOther: "Documents d'une autre identité",
  homeLastStep:
    "Dernière étape : confirmez votre identité pour que vos commentaires portent votre nom.",
  associateLater: "Plus tard",
  associateAgain: (count) =>
    `Associer ${plural(count, { one: "le document", other: `les ${count} documents` })} de ce navigateur à votre identité`,
  attachNeedsKey:
    "Votre liste de documents existe déjà, ouverte sur un autre appareil ou navigateur. Vous identifier ne suffit pas à l'ouvrir ici : elle est chiffrée par une clé que seuls vos appareils détiennent. Ouvrez-la une fois sur ce navigateur : sur un appareil où elle est ouverte, choisissez « Ajouter un appareil » et scannez le code, ou collez ici sa clé. D'ici là, les documents ouverts ici sont gardés au serveur, en attente, et la rejoindront.",
  startOverIntro:
    "Plus d'appareil où elle est ouverte, ni sa clé ? Recommencez une liste : elle remplace l'ancienne pour votre identité, et la liste de ce navigateur y entre. L'ancienne liste est perdue : ses documents ne se retrouvent plus que par leurs liens, ou depuis un appareil où elle est encore ouverte, qui pourra la fusionner dans la nouvelle.",
  startOver: "Recommencer une liste",
  startOverConfirm:
    "Recommencer une liste pour votre identité ? L'ancienne ne pourra plus être ouverte en vous identifiant. Votre identité sera confirmée par une nouvelle identification.",
  startedOver:
    "Liste recommencée. Gardez sa clé, ci-dessous : elle, ou le code d'« Ajouter un appareil », ouvre la liste sur vos autres appareils.",
  homeKeptByIdentity: (identity) =>
    `Vos documents sont gardés avec ${identity} : sur un autre appareil, identifiez-vous et ouvrez-y la liste une fois, par le code d'« Ajouter un appareil » ou par sa clé.`,
  homeKeptByIdentitySignedOut:
    "Vos documents sont gardés avec votre identité : identifiez-vous pour les retrouver à jour.",
  homeKeptByKey:
    "Vos documents sont gardés avec votre clé : collez-la, ou scannez le code d'« Ajouter un appareil », pour les retrouver sur un autre appareil.",
  homeKeptNowhere:
    "Ce navigateur ne garde pas vos documents : vous les retrouvez seulement par leur lien.",
  homeModesTitle: "Comment vos documents sont-ils gardés ?",
  homeModeIdentity:
    "Avec votre identité, quand vous êtes identifié : la liste est gardée au serveur pour votre identité. Sur chaque nouvel appareil ou navigateur, ouvrez-la une fois, par le code d'« Ajouter un appareil » ou par sa clé ; ensuite, vous identifier suffit.",
  homeModeKey:
    "Avec une clé, sans compte : la clé est à vous seul ; perdue, la liste l'est aussi.",
  homeModeNone:
    "Sans rien : chaque document se retrouve par son lien, que vous gardez vous-même.",
  homeModesPrivate:
    "Dans tous les cas, le serveur ne peut lire ni vos documents ni leur liste : c'est pourquoi personne ne peut vous rendre une liste dont vous avez perdu la clé.",
  homeKeyWarningLead: "Important :",
  homeKeyWarning:
    "ni le serveur, ni votre organisation, ni votre identification ne peuvent rouvrir votre liste : elle est chiffrée par une clé que seuls vos appareils détiennent. Gardez cette clé (« Afficher la clé de Mes documents ») dans un gestionnaire de mots de passe. Si vous la perdez avec tous les appareils où la liste est ouverte, vous perdez la liste, et l'accès aux documents dont vous n'avez pas gardé le lien.",
  homeModeYours: "votre cas",
  accountKeyLabel: "Clé de vos documents",
  accountKeyWrong: "Cette clé n'ouvre pas vos documents.",
  keyringSignedOut:
    "Identifiez-vous pour retrouver Mes documents sur vos autres appareils : d'ici là, cette liste reste sur cet appareil. Les documents eux-mêmes se synchronisent normalement.",
  keyringOtherAccount:
    "Cette liste appartient à une autre identité que la vôtre : elle n'est pas synchronisée. Déconnectez-vous, puis identifiez-vous sous cette identité.",
  pairingSignInFirst:
    "Identifiez-vous pour recevoir Mes documents de votre autre appareil.",
  addDeviceSignIn: "Identifiez-vous pour ajouter un appareil.",
  addDevice: "Ajouter un appareil",
  pairingTitle: "Ouvrir Mes documents sur un autre appareil",
  pairingNote:
    "Scannez ce code avec l'appareil photo de l'autre appareil, ou ouvrez-y ce lien. Il sert une fois, pendant 5 minutes. Ne le montrez à personne d'autre.",
  pairingQr: "QR code du lien qui ouvre Mes documents sur un autre appareil",
  pairingLink: "Lien pour l'autre appareil",
  pairingExpired: "Ce code a expiré.",
  pairingNew: "Nouveau code",
  pairingDone: "Terminé",
  pairingTooMany:
    "Trop de codes attendent : utilisez-en un, ou attendez 5 minutes.",
  pairingGone:
    "Ce code a expiré ou a déjà servi : demandez-en un nouveau à l'autre appareil. Si ce n'est pas vous qui l'avez utilisé, changez la clé de Mes documents sur l'autre appareil.",
  pairingUnreadable:
    "Ce code est illisible : demandez-en un nouveau à l'autre appareil.",
  pairingMergeConfirm:
    "Cet appareil a déjà une liste dans Mes documents. Ajouter ses documents à la liste du code ? Qui détient cette liste les verra. Choisissez Annuler si vous ne savez pas d'où vient ce code.",
  pairingKeptOwn: "Cet appareil garde sa propre liste : le code n'a pas servi.",
  pairingJoined: "Mes documents est maintenant aussi sur cet appareil.",
  pairingMerged:
    "Les documents que cet appareil listait déjà ont rejoint la liste.",
  signedWith: (short: string) => `Signé avec la clé de signature ${short}`,
  signedNameLabel: (name: string, short: string) =>
    `${name}, signé avec la clé de signature ${short}`,
  signatureExplains:
    "Écrit avec cette clé. La clé ne dit pas qui la détient : seulement que ce qui porte la même empreinte vient d'elle.",
  signatureLate: (dated: string, received: string) =>
    `Daté du ${dated}, reçu le ${received}.`,
  signatureDetails: "Détails de la signature",
  withAlert: (label, alert) => `${label} : ${alert}`,
  alertKeys: (n) => `${n} clés`,
  alertRevoked: "révoquée",
  alertLate: "reçu tard",
  nameKeysTitle: (name, n) =>
    `Le nom « ${name} » est signé par ${n} clés dans ce document.`,
  nameKeysExplains:
    "Un navigateur où la liste Mes documents n'est pas ouverte a sa propre clé de signature : qui écrit depuis deux appareils peut en avoir deux. Sinon, quelqu'un d'autre a pu prendre ce nom, qui n'est pas vérifié. En cas de doute, demandez à cette personne l'empreinte de sa clé de signature : son menu Document la montre.",
  thisKey: "celle-ci",
  yourKey: "la vôtre",
  keySignedIn: (n) =>
    n === 0
      ? "dans aucune annotation"
      : `dans ${n} ${plural(n, { one: "annotation", other: "annotations" })}`,
  keyRevokedExplains:
    "Votre organisation a retiré cette clé : ce qui est daté d'avant lui reste attribué.",
  signatureLateExplains:
    "Un appareil resté hors ligne, ou un objet daté d'avant son écriture.",
  signingKeyTitle: "Clé de signature",
  signingKeyIntro:
    "Ce que vous écrivez depuis ce navigateur est signé par cette clé. Son empreinte :",
  signingKeyGive:
    "Donnez-la à qui veut vérifier que ce qu'il lit vient de vous : il la compare à celle que montre la clé à côté de votre nom. Elle ne permet ni de lire vos documents, ni de signer à votre place.",
  signingKeyNotKeyring:
    "Ce n'est pas la clé de Mes documents, qui ouvre votre liste : celle-là ne se donne à personne.",
  highlight: "Mettre en évidence",
  highlightKey: (short) => `Mettre en évidence la clé ${short}`,
  keyBroughtForward: (short, n) =>
    `Clé ${short} : ${n} ${plural(n, { one: "annotation mise", other: "annotations mises" })} en évidence`,
  previousOfKey: "Annotation précédente de cette clé",
  nextOfKey: "Annotation suivante de cette clé",
  stopBringingForward: "Ne plus mettre en évidence",
  attestedNameLabel: (name: string, issuer: string) =>
    `${name}, vérifié par ${issuer}`,
  attestedAs: (name: string) => `Nom attesté : ${name}`,
  attestedEmail: (email: string) => `Adresse : ${email}`,
  attestedBy: (issuer: string) => `Attesté par ${issuer}`,
  attestedValid: (from: string, to: string) =>
    `Attestation valable du ${from} au ${to}`,
  attestedExplains:
    "Votre organisation atteste que cette clé était celle de cette personne à la date indiquée.",
  keyRevoked: (date: string) => `Clé révoquée le ${date}.`,
  keepThisDocument: "Garder ce document dans Mes documents",
  keepThisDocumentNote: "Décoché, l'ouvrir ne l'y ajoute plus.",

  // ------------------------------------------------------------ share
  roleRead: "Lecture seule",
  roleSuggest: "Commentaire et suggestion",
  roleEdit: "Édition complète",
  yourAccess: (role) => `Votre accès : ${role}`,
  share: "Partager",
  linksRenewed:
    "Liens renouvelés : tous les liens précédents sont révoqués. Envoyez ces nouveaux liens.",
  roleReadMay: "Lire le texte et les annotations.",
  roleSuggestMay: "Commenter et proposer des modifications.",
  roleEditMay: "Tout modifier, décider des suggestions, gérer le document.",
  shareIntro:
    "Chaque lien contient la clé du document : qui l'a ouvre le document avec ce rôle.",
  copied: "Copié",
  renewOpen: "Renouveler tous les liens…",
  renewWarning:
    "Les trois liens actuels cessent de fonctionner, pour tout le monde, et les personnes connectées sont coupées : à faire si un lien est allé où il ne devait pas, puis envoyer les nouveaux.",
  copy: "Copier",
  renewLinks: "Renouveler tous les liens",
  renewConfirm:
    "Renouveler tous les liens ? Toutes les personnes connectées sont coupées, et chaque lien actuel cesse de fonctionner : il faudra renvoyer les trois nouveaux liens.",

  // ------------------------------------------------------------ lifecycle
  document: "Document",
  deletedFromServer: "Supprimé du serveur.",
  keptUntilDeleted: "Gardé jusqu'à ce qu'un éditeur le supprime.",
  deletedOn: (date, when) => `Supprimé du serveur le ${date} (${when}).`,
  due: "échu",
  inMinutes: (n) =>
    `dans ${n} ${plural(n, { one: "minute", other: "minutes" })}`,
  inHours: (n) => `dans ${n} ${plural(n, { one: "heure", other: "heures" })}`,
  inDays: (n) => `dans ${n} ${plural(n, { one: "jour", other: "jours" })}`,
  expireIn: "Dans",
  expireOn: "Le",
  hours: "heures",
  days: "jours",
  weeks: "semaines",
  set: "Appliquer",
  removeExpiry: "Retirer l'échéance",
  deleteDocument: "Supprimer le document",
  expiryNotConfirmed:
    "Le serveur n'a pas confirmé l'échéance : vérifiez-la une fois reconnecté.",
  expiryTooFar: "Une échéance est à 100 ans au plus.",
  expiryWholeNumber:
    "Indiquez un nombre entier d'heures, de jours ou de semaines, au moins 1.",
  expiryInFuture: "Choisissez une date dans le futur.",
  expiryConfirm: (date) =>
    `Le document sera supprimé du serveur le ${date}, pour tout le monde, et chaque lien cessera de fonctionner. Fixer cette échéance ?`,
  language: "Langue",
  expiry: "Échéance",
  expiryUnit: "Unité",
  deleteWord: "supprimer",
  deleteTypeWord: (word) => `Tapez « ${word} » pour confirmer`,
  deleteNote:
    "Supprime le document du serveur, pour tout le monde : chaque lien cesse de fonctionner, et les modifications pas encore envoyées sont perdues. Qui l'a ouvert en garde une copie locale dans son navigateur.",
  notConnectedNotDeleted: "Pas connecté : le document n'a pas été supprimé.",

  // ------------------------------------------------------------ files
  files: "Fichiers",
  exportMd: "Exporter avec les annotations (CriticMarkup)",
  exportText: "Exporter le texte seul",
  importMd: "Importer un .md",
  exportOmitted: (n) =>
    `${n} ${plural(n, { one: "annotation laissée de côté (son texte n'a pas pu être lu).", other: "annotations laissées de côté (leur texte n'a pas pu être lu)." })}`,
  exportAmbiguous:
    "Un texte contient une marque CriticMarkup ou un renvoi de note, ou une ligne de note commence par ** : relu, ce fichier peut différer.",
  exportPointed: (n) =>
    `${n} ${plural(n, { one: "commentaire écrit comme un point : sa portée croisait", other: "commentaires écrits comme un point : leur portée croisait" })} une suggestion ou un autre commentaire, et ne reviendra pas.`,
  exportImagesMissing: (n) =>
    `${n} ${plural(n, { one: "image n'a pas pu être obtenue : elle reste citée", other: "images n'ont pas pu être obtenues : elles restent citées" })} par l'adresse du serveur.`,
  exportCrossing:
    "Des annotations qui se croisent ne s'écrivent pas en CriticMarkup : décidez d'abord de l'une des deux, ou exportez le texte seul.",
  imported: "Importé.",
  importMoved: (n) =>
    `${n} ${plural(n, { one: "commentaire placé dans un ajout proposé a été déplacé", other: "commentaires placés dans un ajout proposé ont été déplacés" })} à son point d'insertion.`,
  importDropped: (n) =>
    `${n} ${plural(n, { one: "annotation abandonnée", other: "annotations abandonnées" })} (vide, ou dans un ajout proposé).`,
  importOrphanNote: (n) =>
    `${n} ${plural(n, { one: "note sans renvoi", other: "notes sans renvoi" })} : la discussion d'un commentaire est maintenant à la fin du texte, une suggestion a été décidée ailleurs.`,
  importDecidedOutside: (n) =>
    `${n} ${plural(n, { one: "suggestion décidée hors de l'application : sa note a été ignorée", other: "suggestions décidées hors de l'application : leurs notes ont été ignorées" })}.`,
  importDuplicateName: (n) =>
    `${n} ${plural(n, { one: "nom employé deux fois : lu sans sa note", other: "noms employés deux fois : lus sans leur note" })} après le premier.`,
  importNoNote: (n) =>
    `${n} ${plural(n, { one: "annotation sans sa note", other: "annotations sans leur note" })} : à votre nom et datées de maintenant, ou, pour un commentaire, laissées de côté.`,
  importBareHighlight: (n) =>
    `${n} ${plural(n, { one: "surlignage sans commentaire, gardé", other: "surlignages sans commentaire, gardés" })} comme du texte.`,
  importNotEmpty: "Pas importé : le document n'est plus vide.",
  importFailed: (detail) => `Pas importé : ${detail}`,

  // ------------------------------------------------------------ formatting
  formatting: "Mise en forme",
  constructBold: "Gras",
  constructItalic: "Italique",
  constructStrikethrough: "Barré",
  constructHighlight: "Surlignage",
  constructCode: "Code",
  constructLink: "Lien",
  constructParagraph: "Texte",
  constructHeading1: "Titre 1",
  constructHeading2: "Titre 2",
  constructHeading3: "Titre 3",
  constructHeading4: "Titre 4",
  constructHeading5: "Titre 5",
  constructHeading6: "Titre 6",
  constructBulletList: "Liste à puces",
  constructOrderedList: "Liste numérotée",
  constructTaskList: "Liste de tâches",
  constructQuote: "Citation",
  constructCallout: "Encadré",
  constructTable: "Tableau",
  constructCodeBlock: "Bloc de code",
  constructMathBlock: "Formule",
  constructDiagram: "Diagramme",
  constructRule: "Ligne de séparation",
  constructFootnote: "Note de bas de page",
  constructImage: "Image",
  /** A callout's family in the / menu (ADR-0063, EN1). */
  calloutItem: (name: string) => `Encadré : ${name}`,
  calloutNote: "Note",
  calloutAbstract: "Résumé",
  calloutInfo: "Info",
  calloutTodo: "À faire",
  calloutTip: "Astuce",
  calloutSuccess: "Réussite",
  calloutQuestion: "Question",
  calloutWarning: "Attention",
  calloutFailure: "Échec",
  calloutDanger: "Danger",
  calloutBug: "Bogue",
  calloutExample: "Exemple",
  calloutQuote: "Citation",
  keyCtrl: "Ctrl",
  keyShift: "Maj",
  keyAlt: "Alt",
  keyEscape: "Échap",
  keyTab: "Tab",
  keyEnter: "Entrée",
  keyClick: "clic",
  withShortcut: (name, keys) => `${name} (${keys})`,
  paragraphStyle: "Style du paragraphe",
  mixedStyles: "Mélangé",
  moreFormatting: "Plus",
  insert: "Insérer",
  anchorMenu: "Titres du document",
  hideToolbar: "Masquer la barre de mise en forme",
  showToolbar: "Afficher la barre de mise en forme",

  // ------------------------------------------------------------ writing help
  helpTitle: "Aide à l'écriture",
  helpWriting: "Écrire en Markdown",
  helpShortcuts: "Raccourcis",
  helpGoodToKnow: "Bon à savoir",
  helpYouType: "Vous tapez",
  helpYouGet: "Vous obtenez",
  helpDrawn: "Dessiné en lecture",
  helpMarkup:
    "Le balisage reparaît sur la ligne que vous éditez, et disparaît ailleurs.",
  helpSource:
    "« Source » montre le texte tel qu'il est gardé ; « Lecture », le document tel que les autres le lisent.",
  helpSlash:
    "Tapez / en début de ligne pour insérer un titre, une liste, un tableau…",
  helpAnchor:
    "Tapez ](# ou [[# dans un lien pour choisir un titre du document.",
  helpAnnotationText:
    "Les commentaires et les réponses montrent l'emphase, les listes, les citations, le code et les liens qui quittent le document ; pas les titres, tableaux, images, formules, ni les liens internes.",
  helpAwaiting:
    "« À traiter » compte les annotations ouvertes dont la dernière entrée est d'un autre ; ‹ › ou F8 / Maj+F8 vont de l'une à la suivante dans le texte, « Rien à ajouter » en met une de côté jusqu'à sa prochaine réponse.",
  helpSuggestAtCaret:
    "Sans rien sélectionner, « Suggérer » propose un texte à l'endroit du curseur (en Révision, pour qui peut aussi écrire). Au début d'un titre, d'un élément ou d'une citation, il demande où l'ajouter : en nouveau paragraphe avant la ligne, ou au début de son texte.",
  helpAnnotate: "Commenter la sélection",
  helpSend: "Envoyer un commentaire, une suggestion ou une réponse",
  helpMoveSection:
    "Déplacer la section (son titre et son texte) avant la précédente ou après la suivante",
  helpIndent: "Mettre en retrait, ou décaler un élément de liste",
  helpOutdent: "Retirer un retrait, ou remonter un élément de liste",
  helpLeaveText: "Quitter le texte au clavier, vers le champ suivant",
  helpTabMode: "Tab : retrait, ou passage au champ suivant",
  helpMoveLines: "Monter ou descendre les lignes",
  helpCopyLines: "Copier les lignes au-dessus ou au-dessous",
  helpDeleteLine: "Supprimer la ligne",
  helpSlashMenu: "Insérer une construction",
  helpUndo: "Annuler",
  helpRedo: "Rétablir",
  helpFollow: "Ouvrir un lien ; aller d'une note à son texte, et retour",
  // ------------------------------------------------------------ first visit
  welcomeWriter:
    "Ce document s'écrit en Markdown. La mise en forme s'affiche au fil de la frappe ; le balisage (**gras**, # titre…) reste visible sur la ligne où vous écrivez. Tapez / pour insérer un titre, une liste, un tableau.",
  welcomeSuggester:
    "Vous pouvez commenter ce document ou y proposer des modifications : sélectionnez un passage, puis choisissez Commenter ou Suggérer.",
  welcomeHelp: "Voir l'aide",
  welcomeDone: "Compris",
  hintMarkup:
    "Le balisage s'affiche là où vous écrivez ; ailleurs, le texte est mis en forme.",
  hintDiagram: "Ce diagramme est dessiné en Lecture.",
  exampleBold: "**un mot**",
  exampleItalic: "*un mot*",
  exampleStrikethrough: "~~un mot~~",
  exampleHighlight: "==un mot==",
  exampleCode: "`du code`",
  exampleLink: "[un lien](https://example.org)",
  exampleHeading1: "# Un titre",
  exampleHeading2: "## Un sous-titre",
  exampleHeading3: "### Plus petit",
  exampleBulletList: "- un élément\n- un autre",
  exampleOrderedList: "1. premier\n2. deuxième",
  exampleTaskList: "- [ ] à faire\n- [x] fait",
  exampleQuote: "> une citation",
  exampleCallout: "> [!note] Un titre\n> Son texte",
  exampleTable: "| Nom | Rôle |\n| --- | --- |\n| Ana | Autrice |",
  exampleCodeBlock: "```\ndu code\n```",
  exampleMathBlock: "$$\nx^2 + y^2\n$$",
  exampleDiagram: "```mermaid\nflowchart LR\n  A --> B\n```",
  exampleRule: "***",
  exampleFootnote: "Une phrase[^1]\n\n[^1]: Sa note.",
  exampleImage: "![Un schéma](attachment:AAECAwQFBgcICQoLDA0ODw)",

  // ------------------------------------------------------------ views
  write: "Écrire",
  modes: "Vue",
  formatted: "Mis en forme",
  help: "Aide",
  viewChoice: "Affichage",
  preview: "Lecture",
  previewHelp:
    "Le document tel que ses lecteurs le voient : diagrammes et formules dessinés, rien de modifiable.",
  readOnly: "Lecture seule",
  source: "Source",
  sideBySide: "Côte à côte",
  // Qui a écrit (ADR-0059).
  whoWrote: "Qui a écrit",
  whoWroteHelp:
    "Colore le texte selon la personne qui l'a tapé : un collage ou un déplacement est à qui l'a fait, une suppression ne laisse rien voir. Les noms ne sont pas vérifiés.",
  whoWroteLegend: "Qui a écrit le texte affiché",
  wroteAt: (name, when) => `${name}, ${when}`,
  everyone: (n) => `Tous (${n})`,
  outline: "Plan",
  showOutline: "Afficher le plan",
  hideOutline: "Masquer le plan",
  outlineWidth: "Largeur du plan",
  outlineLevels: "Niveaux",
  showLevels: (count: number) =>
    `Montrer ${count} ${plural(count, { one: "niveau", other: "niveaux" })}`,
  collapseHeading: (text: string) => `Replier « ${text} »`,
  expandHeading: (text: string, count: number) =>
    `Déplier « ${text} » (${count} ${plural(count, { one: "titre caché", other: "titres cachés" })})`,
  foldHint: "Alt+clic : tous les titres de cette profondeur",
  outlineWidthHint:
    "Tirer pour élargir ; double-cliquer pour revenir à la largeur par défaut",
  noHeadings: "Aucun titre",
  task: "Tâche",
  quote: "Citation",
  callout: "Encadré",
  wikilinkLocal: "Note du coffre d'un participant, non partagée",
  remoteImageShow: "Afficher",
  remoteImageShowLabel: (host) => `Afficher l'image de ${host}`,
  imageUploading: (name) => `Envoi de ${name}…`,
  imageUploadCancel: "Annuler",
  imageTooLarge: (name, megabytes) =>
    `${name} est trop grande : une image fait au plus ${megabytes} Mo.`,
  imageNotAnImage: (name) =>
    `${name} n'est pas une image que la page affiche (PNG, JPEG, GIF, WebP, AVIF, SVG).`,
  imageMalformed: (name) => `${name} n'a pas pu être lue : non envoyée.`,
  imageDocumentFull: "Ce document a atteint sa limite d'images.",
  imageRefused: "L'image a été refusée : ce lien ne le permet plus.",
  imageUploadFailed: (name) =>
    `${name} n'a pas pu être envoyée : le serveur est injoignable.`,
  imageUploadAnswered: (name, status) =>
    `${name} n'a pas pu être envoyée : le serveur a répondu ${status}.`,
  imageRefusedTooLarge: (name) =>
    `${name} a été refusée comme trop grande (réponse 413) : le serveur, ou un mandataire devant lui, a une limite plus basse.`,
  attachedImageLoading: "Chargement de l'image…",
  attachedImageAbsent: "Image absente de ce document",
  attachedImageUnreadable: "Image illisible",
  attachedImageUnavailable: "Image indisponible : le serveur est injoignable",
  remoteImageWaiting:
    "En cours d'écriture : affichée quand le curseur la quittera",
  remoteImageFrom: (host) => `Image de ${host}`,
  remoteImagesHidden: (count, hosts) =>
    `${count} ${plural(count, { one: "image distante non affichée", other: "images distantes non affichées" })}, de ${hosts}.`,
  remoteImagesMore: (count) => `+${count}`,
  remoteImagesWarning:
    "Les afficher apprend à ces sites, choisis par qui a écrit le texte, votre adresse, le moment où vous lisez, et parfois qui vous êtes si vous y êtes connecté. Ce qu'un participant est en train d'écrire peut être demandé avant qu'il ait fini.",
  remoteImagesShow: "Afficher",
  remoteImagesAlways: "Toujours pour ce document",
  remoteImagesAlwaysNote:
    "y compris celles qu'on ajoutera, quiconque les ajoute",
  remoteImagesShown: "Images distantes affichées.",
  remoteImagesShownAlways:
    "Images distantes toujours affichées sur cet appareil pour ce document : celles qu'on ajoute se chargent aussi.",
  remoteImagesStop: "Ne plus afficher",
  review: "Révision",
  openCount: (n) =>
    `${n} ${plural(n, { one: "annotation ouverte", other: "annotations ouvertes" })}`,
  nothingLeft:
    "Plus rien à décider : chaque annotation ouverte a sa décision en route.",
  history: "Historique",
  pendingInPreview: (n) =>
    `${n} ${plural(n, { one: "suggestion en attente, montrée", other: "suggestions en attente, montrées" })} par des marques : le texte est l'actuel.`,
  // ------------------------------------------------------------ history
  historyNote:
    "Noms choisis par chacun, non vérifiés ; dates des appareils de chacun.",
  noVersion: "Pas encore de version.",
  current: "actuelle",
  versionTitle: (title) => `Version : ${title}`,
  versionsTitle: "Versions",
  appVersion: (version) => `Collab Link, version ${version}`,
  historyGuideEdit:
    "Choisissez une version : vous pourrez la lire, la comparer au texte actuel, la nommer, ou remettre son texte.",
  historyGuideSuggest:
    "Choisissez une version : vous pourrez la lire, la comparer au texte actuel, ou la nommer.",
  historyGuideRead:
    "Choisissez une version : vous pourrez la lire ou la comparer au texte actuel.",
  seeVersion: "Lire cette version",
  compareNow: "Comparer au texte actuel",
  isCurrentVersion: "C'est la version actuelle : rien à comparer.",
  changesLead: "Ce qui a changé depuis cette version jusqu'à maintenant :",
  wordsAdded: (n) => `+${n} ${plural(n, { one: "mot", other: "mots" })}`,
  wordsRemoved: (n) => `−${n} ${plural(n, { one: "mot", other: "mots" })}`,
  versionName: "Nom",
  nameThisVersion: "Nommer cette version",
  restoreThisText: "Remettre ce texte",
  restoreHint:
    "Le texte actuel devient celui de cette version, pour tout le monde ; l'historique garde celui d'avant.",
  deleteThisName: "Supprimer ce nom",
  textNotArrived: "Le texte de cette version n'est pas encore arrivé.",
  restoreConfirm: (label) =>
    `Restaurer le texte de « ${label} » ? C'est une nouvelle modification du texte actuel, pour tout le monde : l'historique garde chaque version, et les annotations et décisions restent telles quelles.`,
  restoredFrom: (label) => `Restauré depuis « ${label} »`,
  namedBy: (author, date) => `nommée par ${author}, ${date}`,
  textNotReceived: " — texte pas encore reçu",
  unknownAuthor: "auteur inconnu",
  undated: "non datée",
  versionNameLength: "Un nom de version a de 1 à 200 caractères.",

  // ------------------------------------------------------------ annotations
  annotate: "Annoter",
  comment: "Commenter",
  suggest: "Suggérer",
  deleteSel: "Supprimer",
  yourComment: "Votre commentaire",
  replaceWith: "Remplacer par (vide : supprimer)",
  addText: "Texte à ajouter",
  additionPlace: "Où ajouter le texte",
  paragraphBefore: "Nouveau paragraphe avant cette ligne",
  lineStart: "Au début de cette ligne",
  why: "Pourquoi ? (facultatif)",
  emptyComment: "Écrivez d'abord un commentaire.",
  nothingChanges: "Rien ne change : modifiez le texte proposé.",
  annotations: "Annotations",
  annotationsCount: (n) => `Annotations (${n})`,
  annotationsInMargin: "Annotations en marge",
  previous: "Précédente",
  next: "Suivante",
  countOf: (i, n) => `${i} sur ${n}`,
  allCount: (n) => `Toutes (${n})`,
  oneAtATime: "Une à une",
  verbComment: "a commenté",
  verbAddition: "propose d'ajouter",
  verbDeletion: "propose de supprimer",
  verbSubstitution: "propose de remplacer",
  acceptAction: "Accepter",
  rejectAction: "Refuser",
  resolveAction: "Résoudre",
  conflictCard:
    "Croise une autre annotation : décidez d'abord de l'une des deux.",
  noOpen:
    "Aucune annotation ouverte. Sélectionnez du texte pour commenter ou suggérer.",
  noOpenRead: "Aucune annotation ouverte.",
  annotationsFilter: "Annotations montrées",
  filterOpen: (n) => `Ouvertes (${n})`,
  filterClosed: (n) => `Closes (${n})`,
  filterAll: (n) => `Toutes (${n})`,
  noClosed: "Aucune annotation close.",
  decidedBy: (name) => `par ${name}`,
  textDeleted: "Texte supprimé",
  seeAnnotatedText: "Voir le texte annoté",
  hideAnnotatedText: "Masquer le texte annoté",
  deletedOnBy: (when, who) => `supprimé le ${when} par ${who}`,
  deletedBy: (who) => `supprimé par ${who}`,
  textThenUnavailable: "Texte d'alors indisponible",
  journalTitle: (title) => `${title} — annotations`,
  journalNone: "Aucune annotation.",
  journalDate: "Date",
  journalState: "État",
  journalAnnotated: "Texte annoté",
  journalUnavailable: "texte d'alors indisponible",
  journalProposed: "Texte proposé",
  journalComment: "Commentaire",
  journalNote: "Note",
  journalReplies: "Réponses",
  colon: "\u00a0:",
  exportJournal: "Exporter le journal des annotations",
  statusOpen: "ouverte",
  statusAccepted: "acceptée",
  statusRejected: "refusée",
  statusResolved: "résolue",
  waitingForItsText: "en attente de son texte",
  waitingForEditor: "en attente d'un éditeur",
  pendingDecision: (decision) => `en attente : ${decision}`,
  proposalWaiting: "(en attente de son texte)",
  proposalInvalid: "(modification invalide)",
  decisionLost: (author, decision) =>
    `Votre décision n'a pas été retenue : ${author} l'avait déjà ${decision}.`,
  accept: "accepter",
  reject: "refuser",
  resolve: "résoudre",
  typeTextFirst: "Tapez d'abord le texte à proposer",
  emptyDocumentAddition: "Rien où ancrer un ajout dans un document vide",
  typeReplacementFirst: "Tapez d'abord le remplacement",
  conflictsWith: (id) => `Croise l'annotation ${id}`,
  tooLargeToAccept:
    "Cette suggestion est trop grande pour être acceptée : refusez-la.",
  suggestionTooLarge:
    "Cette suggestion est trop grande : proposez au plus 6 Mo de texte environ.",
  textTooLarge: "Ce texte est trop grand : écrivez au plus 6 Mo environ.",
  reply: "Répondre",
  yourReply: "Votre réponse",
  send: "Envoyer",
  typeReplyFirst: "Écrivez d'abord une réponse.",
  replyCount: (n) => `${n} ${plural(n, { one: "réponse", other: "réponses" })}`,
  awaiting: "À traiter",
  awaitingCount: (n) =>
    `${n} ${plural(n, { one: "annotation attend", other: "annotations attendent" })} votre réponse`,
  nothingAwaiting: "Rien à traiter",
  previousAwaiting: "Annotation à traiter précédente",
  nextAwaiting: "Annotation à traiter suivante",
  alertReply: (name, text) => `${name} a répondu : ${text}`,
  alertComment: (name, text) => `${name} a commenté : ${text}`,
  alertSuggestion: (name) => `${name} propose une modification`,
  alertsTitle: "Alertes",
  alertsOffer: "Me prévenir dans ce navigateur",
  alertsOfferHelp:
    "Quand une réponse attend la vôtre et que ce document n'est pas sous vos yeux. La notification montre le titre, le nom et le début du texte.",
  alertsOn:
    "Les notifications sont actives : une réponse qui attend la vôtre est signalée.",
  alertsBlocked:
    "Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur.",
  pushOffer: "Me prévenir sur cet appareil",
  pushOfferHelp:
    "Même la page fermée : une réponse à vos annotations, ou le refus de vos suggestions, dans ce document.",
  pushOn: "Cet appareil est prévenu, même la page fermée.",
  inviteQuestion: "Être prévenu quand on vous répond ?",
  inviteLater: "Plus tard",
  inviteUndoDeviceBefore:
    "Vous pourrez arrêter : « Ne plus prévenir cet appareil », dans le menu",
  inviteUndoDeviceAfter:
    "en haut de la vue, section Alertes, pour ce document ; les notifications de ce navigateur, dans ses réglages.",
  inviteUndoBrowser:
    "Vous pourrez les retirer dans les réglages du navigateur.",
  pushStop: "Ne plus prévenir cet appareil",
  pushNeedsKey:
    "Pour être prévenu sur cet appareil, il faut une clé de signature.",
  pushRefused:
    "Le navigateur a refusé : autorisez ses notifications dans ses réglages, puis réessayez.",
  pushGenericTitle: "Collab Link",
  pushGenericBody: "Une réponse attend la vôtre.",
  pushSomeone: "Quelqu'un",
  pushRejected: (name, note) =>
    note
      ? `${name} a refusé votre suggestion : ${note}`
      : `${name} a refusé votre suggestion`,
  setAside: "Rien à ajouter",
  putBack: "Remettre à traiter",
  walkDecide: "À décider",
  walkAwaiting: "À traiter",
  walkChoice: "Ce que la révision parcourt",
  nothingLeftToAnswer: "Plus rien à traiter.",
  waitingForText: "en attente du texte",
  pluginOpenLink: "Ouvrir un lien",
  pluginLinkTitle: "Ouvrir le lien d'un document",
  pluginLinkLabel: "Le lien du document",
  pluginOpen: "Ouvrir",
  pluginNotALink:
    "Ce n'est pas le lien d'un document : il ne nomme aucun document (?doc=).",
  pluginInsecureLink:
    "Le serveur de ce lien est joint sans TLS : son secret traverserait le réseau en clair. Seulement https, ou cet ordinateur.",
  pluginLinkNeeded:
    "Collez le lien de ce document pour l'ouvrir sur cet appareil : commande « Ouvrir un lien ».",
  pluginViewTitle: "Document partagé",
  pluginOpenFailed: (reason) => `Le document n'a pas pu s'ouvrir : ${reason}`,
  pluginModifiedOutside: (copy) =>
    `Le fichier de cette note a été modifié hors du plugin. Cette version est gardée dans « ${copy} » ; le fichier est de nouveau l'export du document.`,
  pluginOutsideCopy: (date) => `modifiée hors du plugin ${date}`,
  pluginResume: "Reprendre cette modification",
  pluginResumed: "La modification est reprise dans le document.",
  pluginResumeFailed: (reason) =>
    `La modification n'a pas pu être reprise : ${reason}`,
  pluginOpenElsewhere: "Ce document est déjà ouvert dans un autre onglet.",
  pluginGoToTab: "Aller à cet onglet",
  pluginUnlink: "Délier cette note",
  pluginNotLinked: "Cette note n'est liée à aucun document partagé.",
  pluginNoKeyring:
    "Cet ordinateur n'a pas de trousseau système : les liens des documents sont gardés par Obsidian sans chiffrement, hors du coffre.",
  pluginShareNote: "Partager cette note",
  pluginObsidianPreview: "Aperçu Obsidian à côté",
  pluginShareTitle: "Partager cette note",
  pluginShareChange:
    "Désormais, cette note s'écrit dans la vue du plugin : son fichier devient une copie que le plugin réécrit. Pour en refaire une note ordinaire : « Délier cette note ».",
  pluginShareProperties:
    "Tout ce que contient la note va à qui en a un lien, ses propriétés (tags, alias…) comprises ; son CriticMarkup devient des commentaires et des suggestions.",
  pluginShareConfirm: "Partager",
  pluginCancel: "Annuler",
  pluginNoServer:
    "Indiquez l'adresse du serveur où créer les documents, dans les réglages du plugin.",
  pluginBadServer:
    "L'adresse du serveur des réglages n'est pas utilisable : https, ou http vers cet ordinateur seulement.",
  pluginShareDenied:
    "Le serveur a refusé le nom ou le mot de passe des réglages du plugin.",
  pluginImagesKept: (names) =>
    `Partagée ; ces images du coffre restent telles quelles, les autres ne les verront pas : ${names}.`,
  pluginShareChanged:
    "La note a changé pendant son partage : elle est laissée telle quelle. Partagez-la de nouveau.",
  pluginShareFailed: (reason) => `La note n'a pas pu être partagée : ${reason}`,
  pluginServer: "Serveur",
  pluginServerDescription:
    "Où « Partager cette note » crée les documents : https://…, ou http vers cet ordinateur.",
  pluginUser: "Nom",
  pluginUserDescription:
    "Si le serveur en demande un pour créer des documents (authentification basique de nginx).",
  pluginPassword: "Mot de passe",
  pluginPasswordDescription:
    "Gardé dans le stockage des secrets d'Obsidian, jamais dans le fichier des réglages du plugin.",
  pluginCheckCredentials: "Tester le nom et le mot de passe",
  pluginCheckCredentialsDescription:
    "Demande au serveur ci-dessus s'il les accepte, sans rien créer.",
  pluginCheckCredentialsButton: "Tester",
  pluginCredentialsAccepted: "Le serveur accepte ce nom et ce mot de passe.",
  pluginCredentialsRefused:
    "Le serveur refuse ce nom ou ce mot de passe : ils ne permettent pas de créer des documents.",
  pluginCredentialsMissing:
    "Le serveur demande un nom et un mot de passe pour créer des documents : renseignez-les ci-dessus.",
  pluginCredentialsNotAsked:
    "Le serveur ne demande ni nom ni mot de passe : quiconque l'atteint crée des documents.",
  pluginServerUnreachable: (server: string) =>
    `${server} n'a pas pu être atteint : vérifiez l'adresse du serveur, et que cet ordinateur l'atteint.`,
  pluginFolder: "Dossier des liens ouverts",
  pluginFolderDescription:
    "Où « Ouvrir un lien » crée la note d'un document qu'il n'a pas encore.",
  pluginMyDocuments: "Mes documents",
  pluginOpenFromMyDocuments: "Ouvrir un document de Mes documents",
  pluginOpenFromMyDocumentsPlaceholder: "Le titre d'un document",
  pluginNoMyDocuments:
    "Mes documents a besoin de garder des données sur cet ordinateur : le stockage d'Obsidian n'est pas disponible ici.",
  pluginMyDocumentsEmpty:
    "Mes documents n'est pas encore gardé sur cet ordinateur : ouvrez-le pour le garder, ou pour le retrouver avec sa clé.",
  pluginIdentity: "Identité",
  pluginGateway: "Passerelle d'identité",
  pluginGatewayDescription:
    "Où vous vous identifiez avec le compte de votre organisation, pour signer de votre nom ce que vous écrivez : https://…, ou http vers cet ordinateur. Donnée par votre organisation.",
  pluginAttestationKeys: "Empreintes de la clé d'attestation",
  pluginAttestationKeysDescription:
    "Une par ligne, telles que votre organisation les publie : un nom n'est montré vérifié que si la clé de la passerelle est l'une d'elles.",
  pluginAttestationKeysBad: (line) =>
    `La ligne ${line} n'est pas une empreinte (64 chiffres hexadécimaux) : aucun nom n'est vérifié tant qu'elle n'est pas corrigée.`,
  pluginReadFromServer: "Lire depuis le serveur",
  pluginReadFromServerDescription:
    "Remplit la passerelle et les empreintes telles que le serveur ci-dessus les nomme, pour que vous les compariez à ce que publie votre organisation.",
  pluginReadFromServerButton: "Lire",
  pluginTrustTitle: "La passerelle d'identité du serveur",
  pluginTrustGateway: (gateway) => `Passerelle : ${gateway}`,
  pluginTrustNoGateway:
    "Pas de passerelle : personne ne s'identifie par ce serveur, mais les noms attestés par les clés ci-dessous sont vérifiés.",
  pluginTrustKeys: "Empreintes de la clé d'attestation :",
  pluginTrustCompare:
    "Comparez-les à ce que publie votre organisation avant de les utiliser : qui choisit ces empreintes choisit les noms montrés vérifiés.",
  pluginTrustConfirm: "Les utiliser",
  pluginServerNamesNoGateway:
    "Le serveur ne nomme aucune clé d'attestation : il n'y a rien à lire.",
  pluginServerUnreadable: (server: string) =>
    `Aucune configuration n'a pu être lue sur ${server} : vérifiez l'adresse du serveur dans les réglages, et que cet ordinateur l'atteint.`,
  pluginNoEd25519:
    "Cette version d'Obsidian ne peut pas signer ce que vous écrivez (pas d'Ed25519) : vos commentaires sont écrits sans signature. Réinstallez Obsidian depuis obsidian.md pour les signer.",
  pluginMoveSectionUp: "Monter la section",
  pluginMoveSectionDown: "Descendre la section",
  pluginEditor: "Éditeur",
  pluginEditorDescription:
    "Où s'écrit une note liée : l'éditeur d'Obsidian (ses raccourcis, Vim, sa mise en forme, les extensions des autres plugins), ou celui de la page.",
  pluginEditorObsidian: "Celui d'Obsidian",
  pluginEditorPage: "Celui de la page",
  pluginConvertLinks: "Convertir les liens vers des notes partagées",
  pluginAddressUnknown:
    "Ce lien désigne un document partagé qui n'est ni dans ce coffre ni dans vos documents : demandez son lien.",
  pluginOpenInBrowser: "Ouvrir dans le navigateur",
  pluginConvertLinksNotEditor:
    "Seul un éditeur du document de cette note peut convertir ses liens.",
  pluginLinksConverted: (count: number) =>
    count === 0
      ? "Aucun lien vers une note liée à convertir."
      : `${count} ${plural(count, { one: "lien converti", other: "liens convertis" })} vers des notes liées.`,
  pluginIncomingLinks: (converted: number, later: number) =>
    `Liens vers cette note : ${converted} convertis dans les notes liées ouvertes ici ; ${later} ${plural(later, { one: "note liée fermée", other: "notes liées fermées" })}, à convertir une fois ouvertes (« Convertir les liens vers des notes partagées »).`,
  pluginEditorUnavailable:
    "L'éditeur d'Obsidian n'a pas pu servir ici (Obsidian a peut-être changé) : la note s'écrit dans l'éditeur de la page.",
  pluginVaultImages: "Images jointes dans le coffre",
  pluginVaultImagesDescription:
    "Les images jointes d'une note liée sont écrites dans le dossier images du dossier ci-dessus, et son fichier les cite : elles se voient hors de la vue, et le coffre en garde une copie. Désactivé, les fichiers déjà écrits restent.",
} satisfies Dictionary;
