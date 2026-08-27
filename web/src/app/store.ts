import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { FeatureCollection } from 'geojson'
import { pointAtAlong, prepareRoute, type PreparedRoute, type RouteData } from '../routing/route'
import { computeNav, navGuidance, type Guidance, type NavState } from '../navigation/nav'
import { PoseController, type PermState, type PoseConfig } from '../sensors/pose'
import {
  deleteRegion,
  downloadRegion,
  fetchCatalog,
  isDownloaded,
  loadRegion,
  nearestRegion,
  registerServiceWorker,
  type Catalog,
  type RegionData,
} from '../offline/regions'
import { buildGraph, routeOnTrails, synthesizeRoute, type TrailGraph } from '../routing/graph'
import type { Pose, LonLat } from '../geo/geo'
import type { TerrainGrid } from '../terrain/terrain'

export type Mode = 'map' | 'explore' | 'ar'

export interface RegionUI {
  state: 'none' | 'downloading' | 'ready'
  pct: number
  error?: string
}

export const controller = new PoseController()

let graphCache: { regionId: string; graph: TrailGraph } | null = null

export interface TSState {
  booted: boolean
  bootError: string | null
  onboarded: boolean
  mode: Mode
  /** the offline/region sheet, when opened outside the map tab */
  regionsOpen: boolean
  online: boolean
  catalog: Catalog | null
  regionUI: Record<string, RegionUI>
  suggestion: { regionId: string; name: string; distKm: number; bytes: number } | null
  region: RegionData | null
  activeRouteId: string | null
  prepared: PreparedRoute | null
  patch: TerrainGrid | null
  navigating: boolean
  flythrough: boolean
  cameraOn: boolean
  pose: Pose
  nav: NavState | null
  guidance: Guidance | null
  cfg: PoseConfig
  deviceOri: PermState
  gps: PermState
  toast: string | null

  boot: () => Promise<void>
  finishOnboarding: () => void
  setMode: (m: Mode) => void
  setRegionsOpen: (open: boolean) => void
  switchRegion: (id: string) => Promise<void>
  selectRoute: (id: string) => void
  startNav: () => void
  stopNav: () => void
  setFlythrough: (on: boolean) => void
  setCameraOn: (on: boolean) => void
  setCfg: (patch: Partial<PoseConfig>) => void
  enableDeviceOrientation: () => Promise<void>
  enableGps: () => void
  useSimulatedPosition: () => void
  calibrateToTrail: () => void
  download: (id: string) => Promise<void>
  removeDownload: (id: string) => Promise<void>
  suggestNearMe: (fallbackToDemo?: boolean) => Promise<void>
  routeToPoint: (dest: LonLat) => void
  clearCustomRoute: () => void
  setToast: (msg: string | null) => void
}

const storeImpl = create<TSState>()(
  subscribeWithSelector((set, get) => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null

    const applyRoute = (id: string | null) => {
      const { region } = get()
      if (!region || !id || !region.routes[id]) {
        controller.setRoute(null, null)
        set({ activeRouteId: null, prepared: null, patch: null, nav: null, guidance: null })
        return
      }
      const prepared = prepareRoute(region.routes[id])
      const patch = region.patches[id] ?? region.terrain
      controller.setRoute(prepared, patch)
      const nav = computeNav(prepared, controller.pose, null)
      set({
        activeRouteId: id,
        prepared,
        patch,
        nav,
        guidance: navGuidance(nav, prepared.name),
        navigating: false,
        flythrough: false,
        pose: { ...controller.pose },
      })
    }

    return {
      booted: false,
      bootError: null,
      onboarded: localStorage.getItem('trailsight.onboarded') === '1',
      mode: 'map',
      regionsOpen: false,
      online: navigator.onLine,
      catalog: null,
      regionUI: {},
      suggestion: null,
      region: null,
      activeRouteId: null,
      prepared: null,
      patch: null,
      navigating: false,
      flythrough: false,
      cameraOn: false,
      pose: { ...controller.pose },
      nav: null,
      guidance: null,
      cfg: { ...controller.cfg },
      deviceOri: 'unknown',
      gps: 'unknown',
      toast: null,

      boot: async () => {
        registerServiceWorker()
        window.addEventListener('online', () => set({ online: true }))
        window.addEventListener('offline', () => set({ online: false }))

        try {
          const catalog = await fetchCatalog()
          const regionUI: Record<string, RegionUI> = {}
          for (const r of catalog.regions) {
            regionUI[r.id] = { state: isDownloaded(r.id) ? 'ready' : 'none', pct: 0 }
          }
          set({ catalog, regionUI })
          const savedId = localStorage.getItem('trailsight.region')
          const first = catalog.regions.find((r) => r.id === savedId) ?? catalog.regions[0]
          if (first) {
            const region = await loadRegion(first.id)
            set({ region })
            const firstRoute = region.manifest.routes[0]?.id ?? null
            applyRoute(firstRoute)
          }
          set({ booted: true })
        } catch (err) {
          set({
            booted: true,
            bootError:
              'Could not load map data. If this is your first visit you need to be online once; downloaded regions keep working offline.',
          })
          console.error(err)
        }

        // pose loop: interval instead of rAF so the simulation keeps
        // advancing even when the window is occluded or backgrounded
        let last = performance.now()
        const tick = () => {
          const now = performance.now()
          const dt = Math.min((now - last) / 1000, 1.1)
          last = now
          controller.update(dt)
          const st = get()
          const p = controller.pose
          const moved =
            !st.pose ||
            Math.abs(p.lon - st.pose.lon) > 1e-9 ||
            Math.abs(p.lat - st.pose.lat) > 1e-9 ||
            Math.abs(p.heading - st.pose.heading) > 0.05 ||
            Math.abs(p.pitch - st.pose.pitch) > 0.05
          if (moved) {
            const pose = { ...p }
            let nav = st.nav
            let guidance = st.guidance
            if (st.prepared) {
              nav = computeNav(st.prepared, pose, st.nav)
              guidance = navGuidance(nav, st.prepared.name)
            }
            set({ pose, nav, guidance })
          }
        }
        setInterval(tick, 33)
      },

      finishOnboarding: () => {
        localStorage.setItem('trailsight.onboarded', '1')
        set({ onboarded: true })
      },

      setMode: (mode) => {
        set({ mode, regionsOpen: false })
        if (mode !== 'ar') set({ cameraOn: false })
        // a flyover previewed in the explorer must not leak into other modes:
        // it hides the chevrons/beacon and fights the first-person camera
        if (mode !== 'explore' && get().flythrough) set({ flythrough: false })
      },

      setRegionsOpen: (open) => set({ regionsOpen: open }),

      switchRegion: async (id) => {
        const { region, catalog } = get()
        if (region?.manifest.id === id) return
        try {
          const next = await loadRegion(id)
          localStorage.setItem('trailsight.region', id)
          set({ region: next, suggestion: null, navigating: false, regionsOpen: false })
          applyRoute(next.manifest.routes[0]?.id ?? null)
          const name = (catalog?.regions.find((r) => r.id === id)?.name ?? id).split(' - ')[0]
          get().setToast(`Opened ${name}`)
        } catch (err) {
          console.error(err)
          get().setToast('Could not open this region — go online once, or download it first.')
        }
      },

      selectRoute: (id) => applyRoute(id),

      startNav: () => {
        const { cfg } = get()
        set({ mode: 'ar', navigating: true, flythrough: false })
        if (cfg.posSource === 'sim') get().setCfg({ playing: true })
      },

      stopNav: () => {
        get().setCfg({ playing: false })
        set({ navigating: false, mode: 'explore' })
        controller.resetLook()
      },

      setFlythrough: (on) => set({ flythrough: on }),

      setCameraOn: (on) => set({ cameraOn: on }),

      setCfg: (patch) => {
        Object.assign(controller.cfg, patch)
        set({ cfg: { ...controller.cfg } })
      },

      enableDeviceOrientation: async () => {
        const res = await controller.requestDeviceOrientation()
        set({ deviceOri: res })
        if (res === 'granted') {
          get().setCfg({ oriSource: 'device' })
          get().setToast('Compass on. If the view looks rotated, face the trail and tap align.')
        } else if (res === 'denied') {
          get().setToast('Motion access denied — drag to look instead.')
        } else {
          get().setToast('No motion sensors here — drag to look.')
        }
      },

      enableGps: () => {
        controller.startGps((msg) => {
          set({ gps: controller.gpsState })
          get().setToast(`GPS unavailable: ${msg}. Staying on the simulated walk.`)
          get().setCfg({ posSource: 'sim' })
        })
        get().setCfg({ posSource: 'gps' })
        set({ gps: controller.gpsState })
        get().setToast('Using device GPS')
      },

      useSimulatedPosition: () => {
        controller.stopGps()
        get().setCfg({ posSource: 'sim' })
        get().setToast('Back on the simulated walk')
      },

      calibrateToTrail: () => {
        const { nav, prepared } = get()
        if (!nav || !prepared) return
        const ahead = pointAtAlong(prepared, nav.snap.alongM + 15)
        controller.calibrate(ahead.bearing)
        get().setToast('Compass aligned to the trail ahead')
      },

      download: async (id) => {
        const ui = get().regionUI[id]
        if (ui?.state === 'downloading') return
        set((s) => ({ regionUI: { ...s.regionUI, [id]: { state: 'downloading', pct: 0 } } }))
        try {
          await downloadRegion(id, (done, total) => {
            set((s) => ({
              regionUI: {
                ...s.regionUI,
                [id]: { state: 'downloading', pct: total ? done / total : 0 },
              },
            }))
          })
          set((s) => ({ regionUI: { ...s.regionUI, [id]: { state: 'ready', pct: 1 } } }))
          get().setToast('Saved. Navigation here now works offline.')
          if (!get().region) await get().boot()
        } catch (err) {
          set((s) => ({
            regionUI: {
              ...s.regionUI,
              [id]: { state: 'none', pct: 0, error: String(err) },
            },
          }))
          get().setToast('Download failed — check your connection.')
        }
      },

      removeDownload: async (id) => {
        await deleteRegion(id)
        set((s) => ({ regionUI: { ...s.regionUI, [id]: { state: 'none', pct: 0 } } }))
        get().setToast('Offline copy removed')
      },

      suggestNearMe: async (fallbackToDemo = true) => {
        const { catalog, region } = get()
        if (!catalog) return
        let here = await PoseController.currentPosition()
        let pretend = false
        if (!here && fallbackToDemo && region) {
          here = { lon: region.manifest.center[0], lat: region.manifest.center[1] }
          pretend = true
        }
        if (!here) {
          get().setToast('Location unavailable — enable location access.')
          return
        }
        const best = nearestRegion(catalog, [here.lon, here.lat])
        if (best) {
          set({
            suggestion: {
              regionId: best.region.id,
              name: best.region.name,
              distKm: pretend ? 0 : Math.round(best.distKm),
              bytes: best.region.bytes,
            },
          })
        }
      },

      routeToPoint: (dest) => {
        const { region, pose } = get()
        if (!region) return
        if (!graphCache || graphCache.regionId !== region.manifest.id) {
          graphCache = {
            regionId: region.manifest.id,
            graph: buildGraph(region.trails as FeatureCollection),
          }
        }
        const path = routeOnTrails(graphCache.graph, [pose.lon, pose.lat], dest)
        if (!path || path.length < 2) {
          get().setToast('No trail connects to that point')
          return
        }
        const custom = synthesizeRoute(path, region.terrain, 'custom', 'Custom destination')
        const routes: Record<string, RouteData> = { ...region.routes, custom }
        const patches = { ...region.patches, custom: region.terrain }
        set({ region: { ...region, routes, patches } })
        applyRoute('custom')
        get().setToast(`Routed on trails · ${(custom.stats.lengthM / 1000).toFixed(1)} km`)
      },

      clearCustomRoute: () => {
        const { region } = get()
        if (!region || !region.routes.custom) return
        const routes = { ...region.routes }
        delete routes.custom
        const patches = { ...region.patches }
        delete patches.custom
        set({ region: { ...region, routes, patches } })
        applyRoute(region.manifest.routes[0]?.id ?? null)
      },

      setToast: (msg) => {
        if (toastTimer) clearTimeout(toastTimer)
        set({ toast: msg })
        if (msg) toastTimer = setTimeout(() => set({ toast: null }), 4000)
      },
    }
  }),
)

export const useStore = storeImpl

// dev-only handle for scripted testing
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__ts = { useStore: storeImpl, controller }
}
