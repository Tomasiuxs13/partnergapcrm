// Site constants in one place (spec 1.2 principle 9, 6.3.1): stages, deal models, activity types,
// affiliate types, team, admins, clients, past clients, sla, follow-up days, reply window, limits...
// G0 stub; owner G1-B. The three lists below carry today's values from lib/crm.js, which keeps its
// own copies until G1-B switches it to import from here. No side effects at import time.

export const STAGES = ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"];
export const DEAL_MODELS = ["Commission (CPA)", "Revenue share", "Flat fee", "Flat fee + commission", "Free placement", "Gifted product"];
export const ACTIVITY_TYPES = ["Email", "Call", "Meeting", "Note", "Deal update", "Content live"];
