//
//  ARNavigationView.swift
//  TrailSight
//
//  RealityKit AR navigation layer.
//
//  Approach: the AR session runs ARWorldTrackingConfiguration with
//  worldAlignment = .gravityAndHeading, so ARKit world axes are meters with
//  -Z = true north, +X = east, +Y = up. Geographic content is converted from
//  lon/lat to a local East-North-Up frame centered on a session origin: the
//  phone's position at the moment the first good GPS fix arrives. A single
//  root anchor entity holds all geo content; ENU offsets map to AR space as
//  (x: east, y: up, z: -north).
//
//  When GPS says the user has drifted more than a few meters from where the
//  AR origin thinks they are, the root anchor is smoothly translated to
//  agree with GPS again instead of resetting the session, so tracking and
//  rendering never hitch.
//

import ARKit
import CoreLocation
import Foundation
import Observation
import RealityKit
import SwiftUI
import UIKit
import simd

// MARK: - Session model shared with the HUD

/// Where the AR session is in its lifecycle, for HUD status messaging.
public enum ARPhase: Equatable, Sendable {
    case initializing
    case waitingForGPS
    /// GPS fix exists but horizontal accuracy (meters) is too poor to lock
    /// the geographic origin.
    case poorAccuracy(Double)
    case tracking
    case relocalizing
}

/// Observable bridge between the AR coordinator and SwiftUI. The AR layer
/// writes at up to 20 Hz; the HUD reads.
@Observable
public final class NavSessionModel {
    public var phase: ARPhase = .initializing
    public var pose: Pose?
    public var nav: NavState?
    public var guidance: Guidance?
    /// Number of smooth re-anchor corrections applied this session.
    public var reanchorCount = 0
    /// Magnitude of the last GPS versus AR drift correction, meters.
    public var lastDriftM: Double = 0
    /// Non-nil when ARKit reports degraded tracking.
    public var trackingWarning: String?

    public init() {}

    /// Clears per-route state when navigation starts or ends.
    public func reset() {
        phase = .initializing
        pose = nil
        nav = nil
        guidance = nil
        reanchorCount = 0
        lastDriftM = 0
        trackingWarning = nil
    }
}

// MARK: - Representable

/// Wraps ARView and drives route content placement plus navigation state.
public struct ARNavigationView: UIViewRepresentable {
    let route: PreparedRoute
    let terrain: TerrainGrid
    let pois: [PointOfInterest]
    let session: NavSessionModel
    let location: LocationService

    public init(
        route: PreparedRoute,
        terrain: TerrainGrid,
        pois: [PointOfInterest],
        session: NavSessionModel,
        location: LocationService
    ) {
        self.route = route
        self.terrain = terrain
        self.pois = pois
        self.session = session
        self.location = location
    }

    /// World tracking with heading alignment is required; false in the
    /// simulator and on devices without a rear camera.
    public static var isSupported: Bool {
        ARWorldTrackingConfiguration.isSupported
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(sessionModel: session, location: location)
    }

    public func makeUIView(context: Context) -> ARView {
        let arView = ARView(frame: .zero)
        arView.automaticallyConfigureSession = false
        arView.renderOptions.insert(.disableMotionBlur)
        arView.renderOptions.insert(.disableDepthOfField)

        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravityAndHeading
        config.planeDetection = []
        config.environmentTexturing = .none

        arView.session.delegate = context.coordinator
        context.coordinator.attach(arView: arView, configuration: config)
        context.coordinator.setContent(route: route, terrain: terrain, pois: pois)
        arView.session.run(config)
        return arView
    }

    public func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.setContent(route: route, terrain: terrain, pois: pois)
    }

    public static func dismantleUIView(_ uiView: ARView, coordinator: Coordinator) {
        uiView.session.pause()
    }

    // MARK: - Coordinator

    /// ARSessionDelegate that owns all geo-anchored entities and updates
    /// them from camera frames and GPS fixes.
    public final class Coordinator: NSObject, ARSessionDelegate {
        // Tuning constants.
        private let eyeHeightM: Float = 1.6
        private let chevronSpacingM: Double = 8
        private let chevronCount = 38 // roughly the next 300 m
        private let chevronRelayoutM: Double = 4
        private let driftThresholdM: Double = 8
        private let originAccuracyM: Double = 25
        private let labelCap = 16

        private let sessionModel: NavSessionModel
        private let location: LocationService
        private weak var arView: ARView?
        private var configuration: ARWorldTrackingConfiguration?

        private var route: PreparedRoute?
        private var terrain: TerrainGrid?
        private var pois: [PointOfInterest] = []

        /// Root of all geographic content; translated during re-anchors.
        private let geoAnchor = AnchorEntity(world: SIMD3<Float>(repeating: 0))
        private var chevrons: [ModelEntity] = []
        private var beacon: Entity?
        private var beaconRing: ModelEntity?
        private var labels: [Entity] = []

        /// East-North frame at the locked geographic origin.
        private var originFrame: LocalFrame?
        /// Terrain elevation at the origin; local y = 0 is this height.
        private var originEle: Double = 0

        private var frameIndex = 0
        private var lastChevronAlongM: Double = -1e9
        private var navState: NavState?
        private var anchorAdded = false

        init(sessionModel: NavSessionModel, location: LocationService) {
            self.sessionModel = sessionModel
            self.location = location
            super.init()
        }

        func attach(arView: ARView, configuration: ARWorldTrackingConfiguration) {
            self.arView = arView
            self.configuration = configuration
            if !anchorAdded {
                arView.scene.addAnchor(geoAnchor)
                anchorAdded = true
            }
        }

        /// Installs or swaps the navigated route. Content is rebuilt when
        /// the next origin lock happens.
        func setContent(route: PreparedRoute, terrain: TerrainGrid, pois: [PointOfInterest]) {
            if self.route?.id == route.id { return }
            self.route = route
            self.terrain = terrain
            self.pois = pois
            resetOrigin()
        }

        /// Drops the geographic origin so the next good fix re-locks it and
        /// rebuilds all content.
        private func resetOrigin() {
            originFrame = nil
            navState = nil
            lastChevronAlongM = -1e9
            geoAnchor.children.removeAll()
            geoAnchor.position = SIMD3<Float>(repeating: 0)
            chevrons = []
            labels = []
            beacon = nil
            beaconRing = nil
            sessionModel.phase = .waitingForGPS
            sessionModel.nav = nil
            sessionModel.guidance = nil
        }

        // MARK: Geometry helpers

        /// Local position (inside geoAnchor) of a geographic point, with
        /// elevation hugging the terrain patch.
        private func localPosition(lon: Double, lat: Double) -> SIMD3<Float> {
            guard let frame = originFrame else { return SIMD3<Float>(repeating: 0) }
            let xy = frame.toXY(lon: lon, lat: lat)
            var ele = originEle
            if let terrain, terrain.contains(lon: lon, lat: lat) {
                ele = terrain.elevAt(lon: lon, lat: lat)
            }
            return SIMD3<Float>(Float(xy.x), Float(ele - originEle), Float(-xy.y))
        }

        /// Compass bearing to AR yaw: rotating -Z (north) clockwise by the
        /// bearing means a rotation of -bearing around +Y.
        private func yawQuat(bearingDeg: Double) -> simd_quatf {
            simd_quatf(angle: Float(-bearingDeg * .pi / 180), axis: SIMD3<Float>(0, 1, 0))
        }

        // MARK: Origin lock

        private func lockOrigin(fix: CLLocation, cameraTransform: simd_float4x4) {
            guard let terrain else { return }
            let lon = fix.coordinate.longitude
            let lat = fix.coordinate.latitude
            originFrame = LocalFrame(lon0: lon, lat0: lat)
            originEle = terrain.contains(lon: lon, lat: lat)
                ? terrain.elevAt(lon: lon, lat: lat)
                : fix.altitude

            // Anchor origin sits on the ground directly under the camera.
            let cam = cameraTransform.columns.3
            geoAnchor.position = SIMD3<Float>(cam.x, cam.y - eyeHeightM, cam.z)
            buildContent()
            sessionModel.phase = .tracking
        }

        // MARK: Entity construction

        private func buildContent() {
            guard let route else { return }
            geoAnchor.children.removeAll()
            chevrons = []
            labels = []

            // Chevron pool for the next stretch of trail.
            let template = Self.makeChevronTemplate()
            for _ in 0..<chevronCount {
                let c = template.clone(recursive: true)
                c.isEnabled = false
                geoAnchor.addChild(c)
                chevrons.append(c)
            }

            // Next-waypoint beacon: ground ring plus vertical light beam.
            let beaconRoot = Entity()
            let ring = Self.makeRing(innerRadius: 1.0, outerRadius: 1.35, segments: 40)
            ring.position = SIMD3<Float>(0, 0.06, 0)
            beaconRoot.addChild(ring)
            let beam = Self.makeBeam(height: 22, radius: 0.16)
            beam.position = SIMD3<Float>(0, 11, 0)
            beaconRoot.addChild(beam)
            beaconRoot.isEnabled = false
            geoAnchor.addChild(beaconRoot)
            beacon = beaconRoot
            beaconRing = ring

            // Billboard labels: named waypoints first, then nearby POIs.
            var labelSpecs: [(text: String, lon: Double, lat: Double)] = []
            let labelKinds: Set<String> = [
                WaypointKind.peak.rawValue, WaypointKind.viewpoint.rawValue,
                WaypointKind.landmark.rawValue, WaypointKind.guidepost.rawValue,
                WaypointKind.water.rawValue, WaypointKind.saddle.rawValue,
                WaypointKind.arrive.rawValue,
            ]
            for wp in route.waypoints where labelKinds.contains(wp.kind) {
                guard let name = wp.name, !name.isEmpty else { continue }
                let p = route.waypointLonLat(wp)
                labelSpecs.append((name, p.lon, p.lat))
            }
            let poiKinds: Set<String> = ["peak", "water", "viewpoint", "landmark", "guidepost"]
            for poi in pois {
                if labelSpecs.count >= labelCap { break }
                guard let name = poi.name, !name.isEmpty else { continue }
                guard let kind = poi.kind, poiKinds.contains(kind) else { continue }
                let snap = route.snap(lon: poi.lon, lat: poi.lat)
                guard snap.offM < 500 else { continue }
                // Skip POIs that duplicate a waypoint label.
                if labelSpecs.contains(where: { $0.text == name }) { continue }
                labelSpecs.append((name, poi.lon, poi.lat))
            }

            for spec in labelSpecs.prefix(labelCap) {
                let label = Self.makeLabel(text: spec.text)
                var pos = localPosition(lon: spec.lon, lat: spec.lat)
                pos.y += 2.4
                label.position = pos
                geoAnchor.addChild(label)
                labels.append(label)
            }
        }

        /// Flat arrowhead pointing along -Z, lying on the ground plane.
        static func makeChevronTemplate() -> ModelEntity {
            let positions: [SIMD3<Float>] = [
                SIMD3<Float>(0, 0, -0.42), // tip
                SIMD3<Float>(0.32, 0, 0.22), // right wing
                SIMD3<Float>(0, 0, 0.04), // notch
                SIMD3<Float>(-0.32, 0, 0.22), // left wing
            ]
            let indices: [UInt32] = [0, 2, 1, 0, 3, 2]
            var desc = MeshDescriptor(name: "chevron")
            desc.positions = MeshBuffers.Positions(positions)
            desc.primitives = .triangles(indices)
            let mesh = (try? MeshResource.generate(from: [desc]))
                ?? MeshResource.generatePlane(width: 0.5, depth: 0.5)
            let material = UnlitMaterial(color: UIColor(red: 0.10, green: 0.85, blue: 0.90, alpha: 1))
            return ModelEntity(mesh: mesh, materials: [material])
        }

        /// Flat annulus used as the beacon's ground ring.
        static func makeRing(innerRadius: Float, outerRadius: Float, segments: Int) -> ModelEntity {
            var positions: [SIMD3<Float>] = []
            var indices: [UInt32] = []
            for s in 0..<segments {
                let a = Float(s) / Float(segments) * 2 * Float.pi
                positions.append(SIMD3<Float>(innerRadius * cos(a), 0, innerRadius * sin(a)))
                positions.append(SIMD3<Float>(outerRadius * cos(a), 0, outerRadius * sin(a)))
            }
            for s in 0..<segments {
                let i0 = UInt32(s * 2)
                let o0 = UInt32(s * 2 + 1)
                let i1 = UInt32(((s + 1) % segments) * 2)
                let o1 = UInt32(((s + 1) % segments) * 2 + 1)
                indices.append(contentsOf: [i0, i1, o0, i1, o1, o0])
            }
            var desc = MeshDescriptor(name: "beaconRing")
            desc.positions = MeshBuffers.Positions(positions)
            desc.primitives = .triangles(indices)
            let mesh = (try? MeshResource.generate(from: [desc]))
                ?? MeshResource.generatePlane(width: 2.4, depth: 2.4)
            let material = UnlitMaterial(color: UIColor(red: 1.0, green: 0.72, blue: 0.10, alpha: 1))
            return ModelEntity(mesh: mesh, materials: [material])
        }

        /// Tall translucent cylinder marking the beacon from far away.
        static func makeBeam(height: Float, radius: Float) -> ModelEntity {
            let mesh = MeshResource.generateCylinder(height: height, radius: radius)
            var material = UnlitMaterial(color: UIColor(red: 1.0, green: 0.72, blue: 0.10, alpha: 0.30))
            material.blending = .transparent(opacity: 0.30)
            return ModelEntity(mesh: mesh, materials: [material])
        }

        /// Billboard text label; the text mesh is centered on the entity's
        /// origin so yaw rotation and distance scaling stay symmetric.
        static func makeLabel(text: String) -> Entity {
            let mesh = MeshResource.generateText(
                text,
                extrusionDepth: 0.02,
                font: .systemFont(ofSize: 0.5, weight: .semibold),
                containerFrame: .zero,
                alignment: .center,
                lineBreakMode: .byTruncatingTail
            )
            let material = UnlitMaterial(color: .white)
            let model = ModelEntity(mesh: mesh, materials: [material])
            let center = mesh.bounds.center
            model.position = SIMD3<Float>(-center.x, -center.y, -center.z)
            let root = Entity()
            root.addChild(model)
            return root
        }

        // MARK: Frame loop

        public func session(_ session: ARSession, didUpdate frame: ARFrame) {
            frameIndex += 1
            let camera = frame.camera
            let transform = camera.transform
            let camPos = SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)

            // Cheap per-frame work: billboards and the beacon pulse.
            updateBillboards(cameraPosition: camPos)
            if let ring = beaconRing {
                let t = Float(frame.timestamp)
                let pulse = 1 + 0.18 * sin(t * 2 * Float.pi / 1.4)
                ring.scale = SIMD3<Float>(pulse, 1, pulse)
            }

            // Nav ticks at 20 Hz.
            guard frameIndex % 3 == 0 else { return }
            guard let route, terrain != nil else { return }

            if case .normal = camera.trackingState {
                sessionModel.trackingWarning = nil
            } else {
                sessionModel.trackingWarning = "Hold the phone up and look around slowly"
            }

            guard let fix = location.lastLocation else {
                if originFrame == nil { sessionModel.phase = .waitingForGPS }
                return
            }

            if originFrame == nil {
                guard fix.horizontalAccuracy > 0, fix.horizontalAccuracy <= originAccuracyM else {
                    sessionModel.phase = .poorAccuracy(max(fix.horizontalAccuracy, 0))
                    return
                }
                lockOrigin(fix: fix, cameraTransform: transform)
            }

            // Heading and pitch from the AR camera: with gravityAndHeading
            // the world frame is aligned to true north, so camera yaw is a
            // compass heading directly.
            let fwd = -SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
            let heading = wrap360(Double(atan2(fwd.x, -fwd.z)) * 180 / .pi)
            let pitch = Double(asin(max(-1, min(1, fwd.y)))) * 180 / .pi

            let lon = fix.coordinate.longitude
            let lat = fix.coordinate.latitude
            var ele = fix.altitude
            if let terrain, terrain.contains(lon: lon, lat: lat) {
                ele = terrain.elevAt(lon: lon, lat: lat)
            }
            let pose = Pose(
                lon: lon, lat: lat, ele: ele,
                heading: heading, pitch: pitch,
                accuracy: fix.horizontalAccuracy,
                speedMps: max(fix.speed, 0),
                ts: fix.timestamp.timeIntervalSince1970
            )

            let nav = NavEngine.compute(route: route, pose: pose, previous: navState)
            navState = nav
            sessionModel.pose = pose
            sessionModel.nav = nav
            sessionModel.guidance = NavEngine.guidance(for: nav, routeName: route.name)
            if sessionModel.phase != .tracking { sessionModel.phase = .tracking }

            reanchorIfNeeded(fix: fix, cameraPosition: camPos)

            if abs(nav.snap.alongM - lastChevronAlongM) > chevronRelayoutM {
                layoutChevrons(alongM: nav.snap.alongM)
                lastChevronAlongM = nav.snap.alongM
            }
            updateBeacon(nav: nav)
        }

        // MARK: Re-anchoring

        /// Compares where GPS says the user is against where the AR frame
        /// thinks they are; above the threshold, smoothly translates the
        /// geo anchor to close the gap instead of resetting the session.
        private func reanchorIfNeeded(fix: CLLocation, cameraPosition camPos: SIMD3<Float>) {
            guard let frame = originFrame, let terrain else { return }
            let lon = fix.coordinate.longitude
            let lat = fix.coordinate.latitude
            let xy = frame.toXY(lon: lon, lat: lat)
            var ele = originEle
            if terrain.contains(lon: lon, lat: lat) {
                ele = terrain.elevAt(lon: lon, lat: lat)
            }
            let expectedLocal = SIMD3<Float>(
                Float(xy.x),
                Float(ele - originEle) + eyeHeightM,
                Float(-xy.y)
            )
            let expectedWorld = geoAnchor.position + expectedLocal
            let dx = Double(camPos.x - expectedWorld.x)
            let dz = Double(camPos.z - expectedWorld.z)
            let drift = (dx * dx + dz * dz).squareRoot()
            guard drift > driftThresholdM else { return }

            var target = geoAnchor.position
            target.x += Float(dx)
            target.z += Float(dz)
            target.y += camPos.y - expectedWorld.y
            let transform = Transform(
                scale: SIMD3<Float>(repeating: 1),
                rotation: simd_quatf(ix: 0, iy: 0, iz: 0, r: 1),
                translation: target
            )
            geoAnchor.move(to: transform, relativeTo: nil, duration: 1.0, timingFunction: .easeInOut)
            sessionModel.reanchorCount += 1
            sessionModel.lastDriftM = drift
        }

        // MARK: Content updates

        /// Repositions the chevron pool to cover the next ~300 m of trail,
        /// hugging terrain heights.
        private func layoutChevrons(alongM: Double) {
            guard let route else { return }
            let total = route.lengthM
            for (k, chevron) in chevrons.enumerated() {
                let d = alongM + 4 + Double(k) * chevronSpacingM
                if d >= total {
                    chevron.isEnabled = false
                    continue
                }
                let p = route.pointAtAlong(d)
                var pos = localPosition(lon: p.lon, lat: p.lat)
                pos.y += 0.05
                chevron.isEnabled = true
                chevron.position = pos
                chevron.orientation = yawQuat(bearingDeg: p.bearing)
            }
        }

        /// Moves the beacon to the next waypoint, or to the rejoin point
        /// while off route. Hidden after arrival.
        private func updateBeacon(nav: NavState) {
            guard let beacon else { return }
            var targetLon: Double?
            var targetLat: Double?
            if nav.phase == .offroute, let off = nav.offRoute {
                targetLon = off.lon
                targetLat = off.lat
            } else if nav.phase == .navigate, let next = nav.next {
                targetLon = next.lon
                targetLat = next.lat
            }
            guard let lon = targetLon, let lat = targetLat else {
                beacon.isEnabled = false
                return
            }
            beacon.isEnabled = true
            beacon.position = localPosition(lon: lon, lat: lat)
        }

        /// Turns labels toward the camera and scales them with distance so
        /// they stay legible without dominating the view.
        private func updateBillboards(cameraPosition camPos: SIMD3<Float>) {
            for label in labels {
                let world = label.position(relativeTo: nil)
                let d = camPos - world
                let dist = simd_length(d)
                guard dist > 0.5 else { continue }
                let yaw = atan2(d.x, d.z)
                label.orientation = simd_quatf(angle: yaw, axis: SIMD3<Float>(0, 1, 0))
                let s = max(1, min(dist / 22, 12))
                label.scale = SIMD3<Float>(repeating: s)
            }
        }

        // MARK: Session lifecycle

        public func session(_ session: ARSession, didFailWithError error: Error) {
            sessionModel.trackingWarning = error.localizedDescription
        }

        public func sessionWasInterrupted(_ session: ARSession) {
            sessionModel.phase = .relocalizing
        }

        public func sessionInterruptionEnded(_ session: ARSession) {
            // Heading may be stale after an interruption; restart tracking
            // and re-lock the origin at the next good fix.
            if let arView, let configuration {
                arView.session.run(configuration, options: [.resetTracking])
            }
            resetOrigin()
        }
    }
}
