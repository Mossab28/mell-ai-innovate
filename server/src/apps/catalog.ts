/** Les applications branchables par Composio. Un catalogue choisi, pas une promesse de tout l'upstream. */
export const APP_CATALOG = [
  { service: "gmail", toolkit: "gmail", name: "Gmail", fr: "tes mails", google: true, cat: "google" },
  { service: "calendar", toolkit: "googlecalendar", name: "Google Agenda", fr: "ton agenda", google: true, cat: "google" },
  { service: "drive", toolkit: "googledrive", name: "Google Drive", fr: "tes fichiers Drive", google: false, cat: "google" },
  { service: "sheets", toolkit: "googlesheets", name: "Google Sheets", fr: "tes feuilles de calcul", google: false, cat: "google" },
  { service: "outlook", toolkit: "outlook", name: "Outlook", fr: "tes mails Outlook", google: false, cat: "microsoft" },
  { service: "onedrive", toolkit: "one_drive", name: "OneDrive", fr: "tes fichiers OneDrive", google: false, cat: "microsoft" },
  { service: "teams", toolkit: "microsoft_teams", name: "Microsoft Teams", fr: "ton Teams", google: false, cat: "microsoft" },
  { service: "slack", toolkit: "slack", name: "Slack", fr: "ton Slack", google: false, cat: "talk" },
  { service: "zoom", toolkit: "zoom", name: "Zoom", fr: "tes réunions Zoom", google: false, cat: "talk" },
  { service: "calendly", toolkit: "calendly", name: "Calendly", fr: "ton Calendly", google: false, cat: "talk" },
  { service: "discord", toolkit: "discord", name: "Discord", fr: "ton Discord", google: false, cat: "talk" },
  { service: "notion", toolkit: "notion", name: "Notion", fr: "tes pages Notion", google: false, cat: "tasks" },
  { service: "todoist", toolkit: "todoist", name: "Todoist", fr: "tes tâches Todoist", google: false, cat: "tasks" },
  { service: "asana", toolkit: "asana", name: "Asana", fr: "tes tâches Asana", google: false, cat: "tasks" },
  { service: "trello", toolkit: "trello", name: "Trello", fr: "tes tableaux Trello", google: false, cat: "tasks" },
  { service: "clickup", toolkit: "clickup", name: "ClickUp", fr: "tes tâches ClickUp", google: false, cat: "tasks" },
  { service: "linear", toolkit: "linear", name: "Linear", fr: "tes tickets Linear", google: false, cat: "tasks" },
  { service: "jira", toolkit: "jira", name: "Jira", fr: "tes tickets Jira", google: false, cat: "tasks" },
  { service: "airtable", toolkit: "airtable", name: "Airtable", fr: "tes bases Airtable", google: false, cat: "tasks" },
  { service: "dropbox", toolkit: "dropbox", name: "Dropbox", fr: "tes fichiers Dropbox", google: false, cat: "files" },
  { service: "github", toolkit: "github", name: "GitHub", fr: "ton GitHub", google: false, cat: "files" },
  { service: "figma", toolkit: "figma", name: "Figma", fr: "tes fichiers Figma", google: false, cat: "files" },
  { service: "canva", toolkit: "canva", name: "Canva", fr: "tes designs Canva", google: false, cat: "files" },
  { service: "hubspot", toolkit: "hubspot", name: "HubSpot", fr: "ton HubSpot", google: false, cat: "work" },
  { service: "stripe", toolkit: "stripe", name: "Stripe", fr: "ton Stripe", google: false, cat: "work" },
  { service: "linkedin", toolkit: "linkedin", name: "LinkedIn", fr: "ton LinkedIn", google: false, cat: "life" },
  { service: "youtube", toolkit: "youtube", name: "YouTube", fr: "ton YouTube", google: false, cat: "life" },
  { service: "strava", toolkit: "strava", name: "Strava", fr: "tes activités Strava", google: false, cat: "life" },
] as const;

/** Les rubriques de l'espace, dans l'ordre d'affichage. */
export const APP_CATEGORIES = ["google", "microsoft", "talk", "tasks", "files", "work", "life"] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

export type AppService = (typeof APP_CATALOG)[number]["service"];
export const APP_SERVICES = APP_CATALOG.map((a) => a.service) as AppService[];
export const isAppService = (v: unknown): v is AppService => typeof v === "string" && (APP_SERVICES as string[]).includes(v);
export const appInfo = (service: AppService) => APP_CATALOG.find((a) => a.service === service)!;
export const toolkitFor = (service: AppService) => appInfo(service).toolkit;
/** Google : gmail/calendar passent par les outils riches existants ; drive/sheets par l'exécuteur générique. */
export const isGoogleApp = (service: AppService) => appInfo(service).google;
