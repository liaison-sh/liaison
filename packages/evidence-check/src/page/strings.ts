// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's words, English and French. Plain facts only: the page says what
// it compared and what it did not check, and never calls the timestamp valid.

export const STRINGS = {
  en: {
    title: "Check a signed document",
    intro:
      "Choose or drop the PDF you want to check. Nothing leaves this computer: this page works without a network.",
    choose: "Choose a file",
    agreement: "Agreement {agreement}, version {version}",
    match: "This is the document they signed",
    matchDocument: "{file} is the document as it was sent for signature (document.pdf).",
    matchSigned: "{file} is the signed PDF, with its signature pages (signed.pdf).",
    noMatch: "This is not the document they signed",
    noMatchDetail: "{file} differs from both files of this agreement.",
    fileFingerprint: "Fingerprint of this file (SHA-256)",
    documentFingerprint: "Fingerprint of the document they signed",
    signedFingerprint: "Fingerprint of the signed PDF",
    packageProblem:
      "This file matches the manifest, but the evidence file does not hold together: see below.",
    sealTitle: "Seal",
    sealDetail:
      "The seal is the SHA-256 of manifest.json. Compare it with the seal in the mail each signer received.",
    manifestCanonical:
      "The manifest is in its canonical form, and the seal was recomputed from it.",
    manifestNotCanonical:
      "The manifest is not in its canonical form: its seal is not the one recomputed from what it says.",
    manifestUnreadable: "The manifest of this evidence file cannot be read. Nothing was checked.",
    trailSealed:
      "The list of events is the sealed one: its fingerprint is the one in the manifest.",
    trailMismatch: "The list of events does not match the fingerprint in the manifest.",
    trailCopy:
      "This list leaves out other people's devices. The full list has the fingerprint in the manifest and is kept by {org}.",
    trailUnreadable: "The list of events cannot be read.",
    tokenAbsent:
      "This evidence file has no timestamp yet. Until it arrives, the copy mailed to each signer is what protects it.",
    tokenNamesSeal: "The timestamp names this seal.",
    tokenNotSeal: "The timestamp does not name this seal.",
    tokenUnreadable: "The timestamp file cannot be read.",
    tokenRefused: "The authority refused the timestamp request (status {status}).",
    tokenTime: "Time given by the authority: {time} (UTC). Serial {serial}, policy {policy}.",
    signatureNotChecked:
      "This page does not check the authority's signature on the timestamp, nor its certificate. To check them, unzip the evidence file and run this, with the authority's published certificate chain saved as tsa-chain.pem:",
    events: "Signatures",
    eventLine: "{name}, {capacity}, signed {time}",
    device: "IP {ip}, browser {ua}",
    hashWebcrypto: "Fingerprints computed with this browser's SHA-256.",
    hashBuiltin: "This browser offers no SHA-256 here, so fingerprints were computed by this page.",
    noData: "This page holds no evidence data. Open the check.html that came in the evidence file.",
  },
  fr: {
    title: "Vérifier un document signé",
    intro:
      "Choisissez ou déposez le PDF à vérifier. Rien ne quitte cet ordinateur : cette page fonctionne sans réseau.",
    choose: "Choisir un fichier",
    agreement: "Accord {agreement}, version {version}",
    match: "Ceci est le document qu'ils ont signé",
    matchDocument: "{file} est le document tel qu'il a été envoyé pour signature (document.pdf).",
    matchSigned: "{file} est le PDF signé, avec ses pages de signature (signed.pdf).",
    noMatch: "Ceci n'est pas le document qu'ils ont signé",
    noMatchDetail: "{file} diffère des deux fichiers de cet accord.",
    fileFingerprint: "Empreinte de ce fichier (SHA-256)",
    documentFingerprint: "Empreinte du document qu'ils ont signé",
    signedFingerprint: "Empreinte du PDF signé",
    packageProblem:
      "Ce fichier correspond au manifeste, mais le dossier de preuve n'est pas cohérent : voir plus bas.",
    sealTitle: "Sceau",
    sealDetail:
      "Le sceau est le SHA-256 de manifest.json. Comparez-le avec le sceau du mail reçu par chaque signataire.",
    manifestCanonical:
      "Le manifeste est sous sa forme canonique, et le sceau a été recalculé à partir de lui.",
    manifestNotCanonical:
      "Le manifeste n'est pas sous sa forme canonique : son sceau n'est pas celui recalculé à partir de son contenu.",
    manifestUnreadable: "Le manifeste de ce dossier de preuve est illisible. Rien n'a été vérifié.",
    trailSealed:
      "La liste des événements est celle qui a été scellée : son empreinte est celle du manifeste.",
    trailMismatch: "La liste des événements ne correspond pas à l'empreinte du manifeste.",
    trailCopy:
      "Cette liste omet les appareils des autres personnes. La liste complète a l'empreinte du manifeste et est conservée par {org}.",
    trailUnreadable: "La liste des événements est illisible.",
    tokenAbsent:
      "Ce dossier de preuve n'a pas encore d'horodatage. En attendant, c'est la copie envoyée par mail à chaque signataire qui le protège.",
    tokenNamesSeal: "L'horodatage porte sur ce sceau.",
    tokenNotSeal: "L'horodatage ne porte pas sur ce sceau.",
    tokenUnreadable: "Le fichier d'horodatage est illisible.",
    tokenRefused: "L'autorité a refusé la demande d'horodatage (statut {status}).",
    tokenTime: "Heure donnée par l'autorité : {time} (UTC). Numéro {serial}, politique {policy}.",
    signatureNotChecked:
      "Cette page ne vérifie ni la signature de l'autorité sur l'horodatage, ni son certificat. Pour les vérifier, décompressez le dossier de preuve et lancez ceci, avec la chaîne de certificats publiée par l'autorité enregistrée sous tsa-chain.pem :",
    events: "Signatures",
    eventLine: "{name}, {capacity}, signé le {time}",
    device: "IP {ip}, navigateur {ua}",
    hashWebcrypto: "Empreintes calculées avec le SHA-256 de ce navigateur.",
    hashBuiltin:
      "Ce navigateur n'offre pas de SHA-256 ici : les empreintes ont été calculées par cette page.",
    noData:
      "Cette page ne contient pas de données de preuve. Ouvrez le check.html livré dans le dossier de preuve.",
  },
} as const

export type StringKey = keyof (typeof STRINGS)["en"]

export function format(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    params[k] === undefined ? m : String(params[k]),
  )
}
