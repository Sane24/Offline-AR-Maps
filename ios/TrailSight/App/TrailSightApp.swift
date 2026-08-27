//
//  TrailSightApp.swift
//  TrailSight
//
//  App entry point and top-level state. TrailSight is an offline-first AR
//  trail navigation app: region packs (terrain grids, routes, POIs) load
//  from the app bundle or from downloaded packs, GPS anchors an ENU frame,
//  and ARKit renders path guidance over the real trail.
//

import Observation
import SwiftUI

/// Top-level app state: services, the loaded region, and the route the
/// user is currently navigating.
@Observable
final class AppModel {
    /// GPS and compass source, shared by the AR layer and the HUD.
    let location = LocationService()
    /// Region pack storage, catalog, and downloads.
    let regions = RegionStore()
    /// Live AR navigation state written by the AR coordinator.
    let navSession = NavSessionModel()

    /// The loaded region pack (the bundled demo region by default).
    var region: RegionData?
    var loadError: String?
    /// The route currently being navigated, nil when browsing.
    var selection: RouteSelection?

    /// Everything the AR session needs for one route.
    struct RouteSelection {
        let meta: RouteMeta
        let prepared: PreparedRoute
        /// High resolution AR patch, or the region terrain as fallback.
        let terrain: TerrainGrid
    }

    /// Loads the catalog and the bundled demo region at launch.
    func bootstrap() async {
        await regions.loadCatalog()
        do {
            let data = try await regions.loadRegion(id: RegionStore.bundledRegionID)
            await MainActor.run { self.region = data }
        } catch {
            await MainActor.run { self.loadError = error.localizedDescription }
        }
    }

    /// Starts AR navigation for a route from the loaded region.
    func start(route meta: RouteMeta) {
        guard let region else { return }
        guard let data = region.routes[meta.id], let prepared = PreparedRoute(data) else {
            loadError = RegionStoreError.badRoute(meta.id).localizedDescription
            return
        }
        navSession.reset()
        location.requestPermission()
        location.start()
        selection = RouteSelection(
            meta: meta,
            prepared: prepared,
            terrain: region.patchOrTerrain(for: meta.id)
        )
    }

    /// Ends the active navigation session and stops sensors.
    func endNavigation() {
        selection = nil
        navSession.reset()
        location.stop()
    }
}

@main
struct TrailSightApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task { await model.bootstrap() }
        }
    }
}
