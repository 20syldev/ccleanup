import type { Messages } from "./messages.ts";

const HELP_FR = `ccleanup - nettoyage interactif des sessions Claude Code

Usage:
  ccleanup [options]

Sans option, ouvre une liste interactive des sessions de ~/.claude/projects, triées
par taille. Marque celles à supprimer, puis valide.

Touches:
  haut/bas, j/k     naviguer        PgUp/PgDn, g/G    page, début, fin
  espace            marquer, puis suivre le dernier sens de déplacement
  a                 tout marquer, ou tout démarquer
  o                 marquer les sessions plus vieilles que --older-than (14d par défaut)
  s, S              changer le tri (taille, âge, projet), inverser l’ordre
  /                 chercher par projet, titre, dossier ou id (échap efface)
  i                 détails de la session sous le curseur
  ?                 aide et légende
  entrée            supprimer les sessions marquées (avec confirmation)
  e                 voir les erreurs de suppression
  q, échap          quitter (Ctrl+C deux fois, Ctrl+Z pour suspendre)

Options:
  -l, --list              afficher la liste sans interface interactive
      --older-than <d>    ne cibler que les sessions plus vieilles que <d> (12h, 14d, 2w, 3m)
      --min-size <s>      ne cibler que les sessions plus grosses que <s> (100K, 500M, 1G)
  -y, --yes               supprimer sans interface les sessions ciblées (exige un filtre)
  -n, --dry-run           montrer ce qui serait supprimé, sans rien supprimer
      --include-recent    autoriser la suppression des sessions modifiées il y a moins de 30 min
                          (jamais celles ouvertes dans Claude Code)
      --claude-dir <dir>  dossier de config Claude, répétable (défaut : ceux qui existent parmi
                          $CLAUDE_CONFIG_DIR, ~/.claude et $XDG_CONFIG_HOME/claude ou ~/.config/claude)

Rappel:
      --install-reminder  installer un timer systemd qui notifie quand il y a de quoi nettoyer
      --every <p>         fréquence du rappel : daily, weekly (défaut) ou monthly
      --notify-above <s>  seuil de la notification (défaut : 1G)
      --uninstall-reminder  retirer le timer
      --check             ce que lance le rappel, à la main : résumer ce qui est nettoyable
                          (14d par défaut), sans rien supprimer
      --notify            avec --check : notification de bureau au-dessus du seuil

  -h, --help              afficher cette aide
  -v, --version           afficher la version

Variables:
  CCLEANUP_LANG=fr|en     langue de l’interface (défaut : celle du système)
  CCLEANUP_NOTIFY=<cmd>   commande de notification, qui reçoit le texte puis le titre
                          (défaut : notify-send)
  CCLEANUP_ASCII=1        dessiner l'interface en ASCII seulement
  NO_COLOR, FORCE_COLOR   désactiver ou forcer les couleurs
`;

/**
 * French plural ending: zero and one take the singular.
 *
 * @param count - Number the word refers to
 * @returns "s" above one, an empty string otherwise
 */
function pluralFr(count: number): string {
    return count > 1 ? "s" : "";
}

/**
 * French texts of the interface.
 */
export const fr: Messages = {
    help: HELP_FR,
    subtitle: "sessions Claude Code",
    columns: { size: "TAILLE", age: "ÂGE", project: "PROJET", title: "TITRE" },
    stats: { sessions: "Sessions", marked: "Marquées", releasable: "Libérable", freed: "Libéré" },
    olderTag: (days) => `plus de ${days} j`,
    totalLine: (count, size) => `${count} session${pluralFr(count)}, ${size}`,
    scanning: (done, total) => `Analyse  ${done}/${total}`,
    scanDone: (count, duration) =>
        `${count} session${pluralFr(count)} analysée${pluralFr(count)} en ${duration}`,
    deleting: (done, total) => `Suppression  ${done}/${total}`,
    keys: {
        move: "naviguer",
        mark: "marquer",
        all: "tout",
        none: "rien",
        old: "anciennes",
        sort: "tri",
        delete: "supprimer",
        quit: "quitter",
        errors: "erreurs",
        yes: "oui",
        no: "non",
        scroll: "défiler",
        close: "fermer",
        stop: "arrêter",
        search: "chercher",
        details: "détails",
        help: "aide",
        clear: "effacer",
        keep: "garder",
    },
    keyNames: {
        arrows: "flèches",
        space: "espace",
        enter: "entrée",
        esc: "échap",
        yes: "o",
        no: "n",
        sort: "s/S",
    },
    usage: {
        unknownOption: (option) => `Option inconnue : ${option}`,
        missingValue: (option) => `Valeur manquante pour ${option}`,
        invalidValue: (option, value, expected) =>
            `Valeur invalide pour ${option} : « ${value} » (attendu : ${expected})`,
        yesNeedsFilter: "--yes exige --older-than ou --min-size, pour ne jamais tout supprimer.",
        hint: "Lance ccleanup --help pour l’aide.",
        expected: {
            "--older-than": "12h, 14d, 2w, 3m",
            "--min-size": "100K, 500M, 1G",
            "--notify-above": "100K, 500M, 1G",
            "--every": "daily, weekly, monthly",
        },
    },
    refusing: (path) => `Suppression refusée hors des sessions : ${path}`,
    confirm: (count, size) => `Supprimer ${count} session${pluralFr(count)} (${size}) ?`,
    confirmHint: "[o/N]",
    confirmKeys: ["o"],
    confirmTitle: "Suppression",
    confirmMore: (count) => `et ${count} autre${pluralFr(count)}`,
    confirmHidden: (count) => `dont ${count} masquée${pluralFr(count)} par la recherche`,
    confirmFinal: (count) =>
        count === 1
            ? "Elle ne pourra plus être reprise avec claude --resume."
            : "Elles ne pourront plus être reprises avec claude --resume.",
    guide: {
        title: "Aide",
        sections: [
            {
                title: "Navigation",
                rows: [
                    ["haut/bas, j/k", "naviguer"],
                    ["PgUp/PgDn", "page précédente, suivante"],
                    ["g/G", "début, fin de la liste"],
                ],
            },
            {
                title: "Marquage",
                rows: [
                    ["espace", "marquer, suivre le sens"],
                    ["a", "tout marquer, démarquer"],
                    ["o", "marquer les anciennes"],
                ],
            },
            {
                title: "Liste",
                rows: [
                    ["/", "chercher (projet, titre, dossier, id)"],
                    ["s/S", "changer le tri, l’inverser"],
                    ["i", "détails de la session"],
                    ["c", "la reprendre dans claude, puis quitter (détails)"],
                ],
            },
            {
                title: "Suppression",
                rows: [
                    ["entrée", "supprimer les marquées"],
                    ["e", "erreurs de suppression"],
                    ["échap", "fermer, effacer la recherche"],
                    ["q", "quitter"],
                ],
            },
        ],
        legendTitle: "Légende",
        legend: {
            marked: "marquée",
            markable: "à marquer",
            open: "ouverte dans Claude Code, jamais supprimée",
            recent: "modifiée il y a moins de 30 min, protégée",
            recentAllowed: "modifiée il y a moins de 30 min (--include-recent)",
            sizes: "taille : grise sous 10 Mo, orange dès 100 Mo, rouge dès 1 Go",
        },
        close: "échap ou ? pour fermer",
    },
    details: {
        title: "Détails",
        folder: "Dossier",
        config: "Config",
        started: "Début",
        modified: "Modifiée",
        size: "Taille",
        parts: {
            transcript: "transcript",
            folder: "dossier",
            history: "historique",
            env: "env",
            debug: "debug",
        },
        state: "État",
        states: {
            open: "ouverte dans Claude Code",
            recent: "récente",
            marked: "marquée",
            idle: "inactive",
        },
        resume: "Reprendre",
        launch: "lancer",
    },
    search: {
        prompt: "chercher",
        none: (query) => `Aucune session ne correspond à « ${query} ».`,
        count: (shown, total) => `${shown} sur ${total}`,
        clearHint: "échap pour effacer",
    },
    done: (count, size) =>
        `${count} session${pluralFr(count)} supprimée${pluralFr(count)}, ${size} libérés.`,
    failed: (count) => `${count} suppression${pluralFr(count)} en échec.`,
    stopping: "Arrêt après la session en cours…",
    ctrlCAgain: "Ctrl+C encore une fois pour quitter",
    noResumeFolder: "Le dossier de cette session n'existe plus : impossible de la reprendre ici.",
    claudeMissing: "claude est introuvable : installez Claude Code ou corrigez le PATH.",
    errorsHint: (count) => `${count} erreur${pluralFr(count)}`,
    errorsTitle: (count) => `Erreurs de suppression (${count})`,
    tooSmall: {
        title: "Terminal trop petit",
        needs: "il faut",
        hint: "Agrandis la fenêtre, ou appuie sur q pour quitter.",
    },
    exitFreed: (size, count) =>
        `${size} libérés, ${count} session${pluralFr(count)} supprimée${pluralFr(count)}`,
    exitNothing: "Rien supprimé, à la prochaine.",
    exitTones: ["Un peu d’air.", "Joli ménage.", "Gros ménage !"],
    exitFailures: (count) => `${count} échec${pluralFr(count)} :`,
    updateAvailable: (latest, current) => `${latest} est disponible, tu as la ${current} :`,
    recent: "récente",
    recentProtected: "Session récente, peut-être active : protégée (voir --include-recent).",
    open: "ouverte",
    openProtected: "Session ouverte dans Claude Code : protégée.",
    openSkipped: (count) =>
        `${count} session${pluralFr(count)} ouverte${pluralFr(count)} entre-temps, gardée${pluralFr(count)}.`,
    nothingMarked: "Rien de marqué.",
    noSessions: (dirs) =>
        `Aucune session Claude Code trouvée dans ${dirs.join(", ")} (voir --claude-dir).`,
    denied: (paths) => `Lecture refusée, vérifie les permissions : ${paths.join(", ")}`,
    nothingMatches: "Aucune session ne correspond aux filtres.",
    wouldDelete: (count, size) =>
        `À supprimer : ${count} session${pluralFr(count)} (${size}). Rien n’a été supprimé.`,
    checkLine: (count, days, size) =>
        `${count} session${pluralFr(count)} de plus de ${days} j nettoyable${pluralFr(count)} : ${size}.`,
    checkNothing: (days) => `Aucune session de plus de ${days} j.`,
    notifyTitle: "Sessions Claude Code à nettoyer",
    notifyBody: (count, days, size) =>
        `${size} dans ${count} session${pluralFr(count)} de plus de ${days} j. Lance « npx ccleanup ».`,
    notifyFailed: "Notification impossible (notify-send introuvable ?).",
    reminderInstalled: (every) => `Rappel ${every} installé (ccleanup-reminder.timer).`,
    reminderRemoved: "Rappel retiré.",
    reminderDry: "Simulation : rien n’a été écrit ni activé.",
    reminderNeedsGlobal:
        "ccleanup tourne depuis le cache npx, qui est temporaire. Installe-le d’abord : npm i -g ccleanup",
    reminderNeedsSystemd: "Le rappel automatique demande Linux avec systemd.",
};
