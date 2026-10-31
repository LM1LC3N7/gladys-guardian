// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, valve states, the status
// of the integration, the answer of the test button and the command errors.
// There is no secret to leak: the local API has no password.
// -----------------------------------------------------------------------------

import { FEATURES, VALVE_STATES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** Several texts, one per line. */
export const lines = (...texts) =>
  both(texts.map((t) => t.en).join('\n'), texts.map((t) => t.fr).join('\n'));

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  names: {
    controller: both('Guardian valve', 'Vanne Guardian'),
    sensor: both('Guardian leak sensor', 'Détecteur de fuite Guardian'),
  },
  controller: {
    [FEATURES.VALVE]: both('Valve', 'Vanne'),
    [FEATURES.VALVE_OPEN]: both('Valve open', 'Vanne ouverte'),
    [FEATURES.CLOSE]: both('Close the valve', 'Fermer la vanne'),
    [FEATURES.OPEN]: both('Open the valve', 'Ouvrir la vanne'),
    [FEATURES.LEAK]: both('Leak (onboard sensor)', 'Fuite (capteur intégré)'),
    [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  },
  sensor: {
    [FEATURES.LEAK]: both('Leak', 'Fuite'),
    [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
    [FEATURES.BATTERY]: both('Battery', 'Pile'),
    [FEATURES.MOVED]: both('Moved', 'Déplacé'),
  },
};

const VALVE_NAMES = {
  default: both('position unknown', 'position inconnue'),
  start_opening: both('opening', 'en ouverture'),
  opening: both('opening', 'en ouverture'),
  finish_opening: both('opening', 'en ouverture'),
  opened: both('open', 'ouverte'),
  start_closing: both('closing', 'en fermeture'),
  closing: both('closing', 'en fermeture'),
  finish_closing: both('closing', 'en fermeture'),
  closed: both('closed', 'fermée'),
  start_halt: both('stopping', 'en arrêt'),
  stalled: both('stalled (motor blocked)', 'bloquée (moteur)'),
  free_spin: both('fault (motor spins freely)', 'en défaut (moteur libre)'),
  halted: both('halted mid-way', 'arrêtée à mi-course'),
};

/** The text of a valve state (0..12), "unknown" when not read. */
export const valveText = (state) => VALVE_NAMES[VALVE_STATES[state]] ?? both('not read', 'non lue');

const list = (items) => items.join(', ');

/** The name of a secondary part of a read (src/app.js readAll). */
function partName(name) {
  if (name === 'onboard') return both('onboard sensor', 'capteur intégré');
  if (name === 'sensors') return both('list of the sensors', 'liste des détecteurs');
  if (name === 'diagnostics') return both('diagnostics', 'diagnostic');
  return both(name, name.replace('sensor', 'détecteur'));
}

export const T = {
  configUnreadable: both(
    'The configuration cannot be read from Gladys: tried again every 30 s. A close kept still goes.',
    'La configuration ne peut pas être lue depuis Gladys : nouvel essai toutes les 30 s. Une fermeture en attente part quand même.',
  ),
  waitingConfig: both('Waiting for the configuration.', 'En attente de la configuration.'),
  noAddress: both(
    'Enter the address of the valve controller (IP address or host name).',
    "Saisissez l'adresse du contrôleur de vanne (adresse IP ou nom d'hôte).",
  ),
  invalidEntries: (positions) =>
    both(
      `Address ${list(positions)} of the list is not valid (IPv4 address or host name, optional :port; no broadcast nor multicast): ignored.`,
      `L'adresse ${list(positions)} de la liste n'est pas valide (adresse IPv4 ou nom d'hôte, :port facultatif ; ni diffusion ni multicast) : ignorée.`,
    ),
  tooMany: both(
    'More than 8 addresses: the first 8 only.',
    'Plus de 8 adresses : les 8 premières seulement.',
  ),
  dataUnreadable: both(
    '/data/guardian-state.json cannot be read: never overwritten; a close kept there is not known.',
    '/data/guardian-state.json est illisible : jamais écrasé ; une fermeture qui y serait gardée est inconnue.',
  ),
  connecting: (where) =>
    both(`${where}: first read in progress.`, `${where} : première lecture en cours.`),
  unreachable: (where, reason) =>
    both(
      `${where}: no answer (${reason}); tried again at the next interval.`,
      `${where} : pas de réponse (${reason}) ; nouvel essai à l'intervalle suivant.`,
    ),
  notGuardian: (where) =>
    both(
      `${where}: the answer is not the one of a Guardian valve controller (identity or valve state unreadable).`,
      `${where} : la réponse n'est pas celle d'un contrôleur de vanne Guardian (identité ou état de vanne illisible).`,
    ),
  controllerLine: ({ uid, where, valve, sensors, leaks, failed }) => {
    let en = `Guardian ${uid} (${where}): valve ${valve.en}, ${sensors} paired sensor(s).`;
    let fr = `Guardian ${uid} (${where}) : vanne ${valve.fr}, ${sensors} détecteur(s) appairé(s).`;
    if (leaks.length > 0) {
      en += ` LEAK: ${list(leaks)}.`;
      fr += ` FUITE : ${list(leaks)}.`;
    }
    if (failed.length > 0) {
      const parts = failed.map(partName);
      en += ` Not read: ${list(parts.map((p) => p.en))}.`;
      fr += ` Non lu : ${list(parts.map((p) => p.fr))}.`;
    }
    return both(en, fr);
  },
  sensorsCut: both(
    'More than 16 paired sensors: the first 16 only.',
    'Plus de 16 détecteurs appairés : les 16 premiers seulement.',
  ),
  replaced: (where, before, now) =>
    both(
      `${where} answered ${before} before and ${now} now: two devices (the old one is no longer read).`,
      `${where} répondait ${before} et répond ${now} : deux appareils (l'ancien n'est plus lu).`,
    ),
  openDisabled: both(
    'Opening the valve from Gladys is off (option "Allow opening the valve"). Closing always works.',
    "L'ouverture de la vanne depuis Gladys est désactivée (option « Autoriser l'ouverture de la vanne »). La fermeture marche toujours.",
  ),
  notSooner: (wait) =>
    both(
      `Not read again sooner than the interval: next read in ${wait.en}.`,
      `Pas relu avant l'intervalle : prochaine lecture dans ${wait.fr}.`,
    ),
  stopSending: (where) =>
    both(`Close at ${where}: being sent.`, `Fermeture vers ${where} : envoi en cours.`),
  stopNotSent: (where, reason) =>
    both(
      `Close at ${where}: not sent yet (${reason}); kept, sent as soon as the controller answers.`,
      `Fermeture vers ${where} : pas encore envoyée (${reason}) ; gardée, envoyée dès que le contrôleur répond.`,
    ),
  stopUnconfirmed: (where) =>
    both(
      `Close at ${where}: sent, not seen applied yet; checked again.`,
      `Fermeture vers ${where} : envoyée, pas encore vue appliquée ; revérifiée.`,
    ),
  stopClosing: (where) =>
    both(
      `Close at ${where}: the valve is closing.`,
      `Fermeture vers ${where} : la vanne se ferme.`,
    ),
  stopClosingLong: (where) =>
    both(
      `Close at ${where}: the valve has been closing for more than 2 minutes: check it.`,
      `Fermeture vers ${where} : la vanne se ferme depuis plus de 2 minutes : vérifiez-la.`,
    ),
  stopOpenedElsewhere: (where) =>
    both(
      `Close at ${where}: the valve reads open again; let go if the next read says so too.`,
      `Fermeture vers ${where} : la vanne se lit de nouveau ouverte ; abandonnée si la lecture suivante le confirme.`,
    ),
  stopRefused: (where, reason) =>
    both(
      `Close at ${where}: refused by the controller (${reason}); sent again at each check.`,
      `Fermeture vers ${where} : refusée par le contrôleur (${reason}) ; renvoyée à chaque vérification.`,
    ),
  stopHeld: (where) =>
    both(
      `Close at ${where}: accepted 3 times but the valve does not close: no more tries until a new click. Check the valve.`,
      `Fermeture vers ${where} : acceptée 3 fois mais la vanne ne se ferme pas : plus d'essai avant un nouveau clic. Vérifiez la vanne.`,
    ),
};

export const ERRORS = {
  readOnly: both('This feature cannot be commanded.', 'Cette fonction ne se commande pas.'),
  badButton: both('Unexpected value for a button.', 'Valeur inattendue pour un bouton.'),
  openDisabled: both(
    'Opening the valve is off: turn on "Allow opening the valve" in the configuration.',
    "L'ouverture est désactivée : activez « Autoriser l'ouverture de la vanne » dans la configuration.",
  ),
  configChanged: both(
    'The configuration changed: nothing sent.',
    'La configuration a changé : rien envoyé.',
  ),
  closeMeanwhile: both(
    'A close was clicked: the open is not sent.',
    "Une fermeture a été demandée : l'ouverture n'est pas envoyée.",
  ),
  tooSlow: both(
    'The controller is too slow to answer: nothing sent.',
    'Le contrôleur répond trop lentement : rien envoyé.',
  ),
  openUnknown: both(
    'This valve was not read at a configured address in this run: nothing sent.',
    "Cette vanne n'a pas été lue à une adresse configurée depuis le démarrage : rien envoyé.",
  ),
  openInProgress: both('An open is already in progress.', 'Une ouverture est déjà en cours.'),
  identityUnreadable: both(
    "The controller's identity cannot be read: nothing sent.",
    "L'identité du contrôleur est illisible : rien envoyé.",
  ),
  otherController: both(
    'Another controller answers at this address: nothing sent.',
    'Un autre contrôleur répond à cette adresse : rien envoyé.',
  ),
  stateUnknown: (reason) =>
    both(
      `The valve cannot be read (${reason}): nothing sent.`,
      `La vanne ne peut pas être lue (${reason}) : rien envoyé.`,
    ),
  leakNow: both(
    'The onboard sensor reads a leak: the valve stays closed.',
    'Le capteur intégré détecte une fuite : la vanne reste fermée.',
  ),
  leakUnknown: both(
    'The onboard leak sensor cannot be read: nothing sent.',
    'Le capteur de fuite intégré ne peut pas être lu : rien envoyé.',
  ),
  leakSensor: (uids) =>
    both(
      `Leak sensor ${list(uids)} reads a leak: the valve stays closed.`,
      `Le détecteur ${list(uids)} détecte une fuite : la vanne reste fermée.`,
    ),
  moving: (state) =>
    both(
      `The valve is moving (${state.en}): nothing sent, try again in a moment.`,
      `La vanne bouge (${state.fr}) : rien envoyé, réessayez dans un instant.`,
    ),
  badState: (state) =>
    both(
      `The valve is ${state.en}: not opened from Gladys.`,
      `La vanne est ${state.fr} : pas d'ouverture depuis Gladys.`,
    ),
  dataNotWritten: both(
    'A close is kept for this valve and /data cannot be written: nothing sent (a restart would close it again).',
    'Une fermeture est gardée pour cette vanne et /data ne peut pas être écrit : rien envoyé (un redémarrage la refermerait).',
  ),
  openNotSent: (reason) => both(`Open not sent (${reason}).`, `Ouverture non envoyée (${reason}).`),
  openRefused: (reason) =>
    both(
      `Open refused by the controller (${reason}).`,
      `Ouverture refusée par le contrôleur (${reason}).`,
    ),
  openSentUnconfirmed: (reason) =>
    both(
      `Open sent, without confirmation (${reason}): read again in 5 s.`,
      `Ouverture envoyée, sans confirmation (${reason}) : relue dans 5 s.`,
    ),
  openNotApplied: both(
    'Open sent, the valve still reads closed: read again in 5 s.',
    'Ouverture envoyée, la vanne se lit encore fermée : relue dans 5 s.',
  ),
  openDiffers: (state) =>
    both(
      `Open sent, the valve reads ${state.en}: read again in 5 s.`,
      `Ouverture envoyée, la vanne se lit ${state.fr} : relue dans 5 s.`,
    ),
  closeNoAddress: both(
    'No address known for this valve yet: enter it in the configuration.',
    'Aucune adresse connue pour cette vanne : saisissez-la dans la configuration.',
  ),
  closeElsewhere: both(
    'This valve is not at any configured address (each holds another valve): nothing sent.',
    "Cette vanne n'est à aucune adresse configurée (chacune a une autre vanne) : rien envoyé.",
  ),
  closeUnconfirmed: (where) =>
    both(
      `Close sent to ${where}, not confirmed yet: checked again.`,
      `Fermeture envoyée vers ${where}, pas encore confirmée : revérifiée.`,
    ),
  closePending: (where) =>
    both(
      `Close to ${where} not sent yet: kept, sent as soon as possible.`,
      `Fermeture vers ${where} pas encore envoyée : gardée, envoyée dès que possible.`,
    ),
  closeNotSent: (where, reason) =>
    both(
      `Close not sent to ${where} (${reason}): kept, sent as soon as the controller answers.`,
      `Fermeture non envoyée vers ${where} (${reason}) : gardée, envoyée dès que le contrôleur répond.`,
    ),
  closeBusy: (where) =>
    both(
      `The valve at ${where} is moving and refuses any command meanwhile: the close is kept and sent again until it is taken.`,
      `La vanne ${where} bouge et refuse toute commande pendant ce temps : la fermeture est gardée et renvoyée jusqu'à ce qu'elle soit prise.`,
    ),
  closeNoAnswer: (where) =>
    both(
      `Close sent to ${where} without an answer: kept, checked again.`,
      `Fermeture envoyée vers ${where} sans réponse : gardée, revérifiée.`,
    ),
  closeRefused: (where, reason) =>
    both(
      `Close refused by the controller at ${where} (${reason}): kept, sent again.`,
      `Fermeture refusée par le contrôleur ${where} (${reason}) : gardée, renvoyée.`,
    ),
  closeOther: (where) =>
    both(
      `Another valve answers at ${where}: this one is not there.`,
      `Une autre vanne répond à ${where} : celle-ci n'y est pas.`,
    ),
};
