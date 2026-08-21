/** schema.md §22 */
export enum MediaKind {
  Image = 'image',
  Video = 'video',
  Gif = 'gif',
  Audio = 'audio',
  Document = 'document',
  Sticker = 'sticker',
}

export enum AttachmentStatus {
  Active = 'active',
  Expired = 'expired',
  Downloading = 'downloading',
  DownloadFailed = 'download_failed',
}
