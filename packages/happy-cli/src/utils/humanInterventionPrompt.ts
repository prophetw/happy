export const HUMAN_INTERVENTION_INSTRUCTION = [
    'When work is blocked by an OS action only the user can perform (a sudo password prompt, Windows UAC, or another local confirmation),',
    'call request_human_intervention from the happy MCP server with kind sudo, uac, or manual and concrete instructions describing where to act.',
    'Only report a confirmed need for human action; a sudo command or slow tool alone is not evidence.',
    'Never ask the user to send passwords or secrets through chat.',
    'After reporting, stop dependent work and end your turn. Do not poll or repeatedly retry.',
    'Happy will send a user follow-up after they handle or cancel it. Verify the actual command result before continuing; the acknowledgement does not grant OS privileges.',
].join(' ');
