/**
 * Camera feed for the AR background: rear camera via getUserMedia.
 * When unavailable (desktop, denied), the simulated terrain world is
 * rendered instead and the guidance stack is unchanged.
 */
import type { PermState } from './pose'

/** Camera feed manager for the AR background. */
export class CameraFeed {
  stream: MediaStream | null = null
  state: PermState = 'unknown'

  async start(video: HTMLVideoElement): Promise<PermState> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.state = 'unsupported'
      return 'unsupported'
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      video.srcObject = this.stream
      await video.play()
      this.state = 'granted'
      return 'granted'
    } catch {
      this.state = 'denied'
      return 'denied'
    }
  }

  stop(video?: HTMLVideoElement | null) {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (video) video.srcObject = null
  }
}
