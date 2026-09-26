export const en = {
  start: '⚡ IQ Media Downloader\n\nDownload. Fast. Simple.\n\nSend me a supported media link and choose your preferred format.',
  help: 'Send one public media link, then choose an available format. Only download content you own or are authorized to save. Private, login-only and DRM content are not supported.\n\n/start — Menu\n/help — Help\n/history — My Downloads\n/settings — Preferences\n/admin — Administrator tools\n\nPlatform adapters: TikTok, Instagram, Facebook, YouTube, X / Twitter, Reddit, Pinterest and direct public media URLs. Availability depends on the link; no platform is live verified yet.',
  maintenance: '🛠 IQ is temporarily under maintenance.\nPlease try again later.',
  PRIVATE_CONTENT: 'This content requires access that IQ does not have. Send a public link.',
  MEDIA_UNAVAILABLE: 'This media is unavailable. Please try another public link.',
  MEDIA_TOO_LARGE: 'This media exceeds the configured size limit. Choose a smaller format.',
  FORMAT_UNAVAILABLE: 'That format is no longer available. Send the link again.',
  DOWNLOAD_TIMEOUT: 'The download timed out. Please try again later.',
  UNSUPPORTED_LINK: 'This link is not supported. Send a supported public media link.',
  BLOCKED_URL: 'This URL is blocked for security reasons.',
  UNKNOWN: 'The request could not be completed. Please try again later.'
};
export const translate = (_language: string): typeof en => en;
