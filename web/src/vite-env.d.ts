/// <reference types="vite/client" />

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

interface DeviceOrientationEventStatic {
  requestPermission?: () => Promise<'granted' | 'denied'>
}
