//
//  NavEngine.swift
//  TrailSight
//
//  Pure functional navigation engine, a Swift port of the web app's nav.ts.
//  Given a prepared route and the latest pose it produces a NavState:
//  where you are along the route, what is next, whether you are off trail,
//  and how much distance and climb remain. The same constants and formulas
//  as the web keep the two clients in lockstep.
//

import Foundation

/// High-level phase of a navigation session.
public enum NavPhase: String, Sendable {
    case navigate
    case offroute
    case arrived
}

/// A waypoint the guidance is currently pointing at, with live geometry
/// relative to the hiker.
public struct NavTarget: Sendable {
    public let wp: Waypoint
    public let lon: Double
    public let lat: Double
    public let ele: Double
    public let distM: Double
    public let bearing: Double
    /// Bearing relative to the current heading, in [-180, 180).
    public let relBearing: Double
}

/// Details shown while off route: how far off, and where to rejoin.
public struct OffRouteInfo: Sendable {
    public let distM: Double
    public let bearing: Double
    public let relBearing: Double
    /// A rejoin point slightly ahead of the snap, so guidance pulls the
    /// hiker forward instead of straight sideways.
    public let lon: Double
    public let lat: Double
}

/// Full output of one navigation update.
public struct NavState: Sendable {
    public let phase: NavPhase
    public let snap: Snap
    public let remainM: Double
    public let remainGainM: Double
    public let etaMin: Double
    /// 0..1 along the route.
    public let progress: Double
    /// The waypoint guidance is pointing at right now.
    public let next: NavTarget?
    /// The one after, for "then ..." previews.
    public let upcoming: NavTarget?
    public let offRoute: OffRouteInfo?
}

/// Guidance banner content for the HUD.
public struct Guidance: Sendable {
    public enum Tone: String, Sendable {
        case ok
        case action
        case warn
        case done
    }

    public let title: String
    public let sub: String
    public let tone: Tone
}

/// Stateless navigation computations. All functions are pure; hysteresis is
/// carried through the `previous` state argument.
public enum NavEngine {
    /// Off-route hysteresis: enter above 35 m, exit below 18 m.
    public static let offEnterM: Double = 35
    public static let offExitM: Double = 18
    /// Arrival window: under 25 m remaining along the line and under 50 m
    /// plain distance to the final vertex.
    public static let arriveM: Double = 25
    /// Once arrived, stay arrived while within this distance of the end.
    public static let resumeM: Double = 60

    /// Builds a live target for a waypoint from the current pose.
    static func target(route r: PreparedRoute, pose: Pose, wp: Waypoint) -> NavTarget {
        let p = r.waypointLonLat(wp)
        let ele = r.waypointEle(wp)
        let distM = haversineM(pose.lonLat, p)
        let bearing = bearingDeg(from: pose.lonLat, to: p)
        return NavTarget(
            wp: wp, lon: p.lon, lat: p.lat, ele: ele,
            distM: distM, bearing: bearing,
            relBearing: angDiffDeg(from: pose.heading, to: bearing)
        )
    }

    /// One navigation update. `previous` supplies hysteresis for the
    /// off-route and arrived phases; pass nil on the first tick.
    public static func compute(route r: PreparedRoute, pose: Pose, previous: NavState?) -> NavState {
        let snap = r.snap(lon: pose.lon, lat: pose.lat)
        let lengthM = r.cum[r.cum.count - 1]
        let remainM = max(0, lengthM - snap.alongM)
        let remainGainM = r.remGain[min(snap.seg + 1, r.remGain.count - 1)]
        let progress = lengthM > 0 ? snap.alongM / lengthM : 0

        // Arrived: near the end both along the line and in plain distance.
        let endIndex = r.coords.count - 1
        let end = r.data.lonLat(at: endIndex)
        let distToEnd = haversineM(pose.lonLat, end)
        var arrived = remainM < arriveM && distToEnd < arriveM * 2
        if previous?.phase == .arrived && distToEnd < resumeM {
            arrived = true
        }

        // Off route with hysteresis.
        let wasOff = previous?.phase == .offroute
        let isOff = snap.offM > (wasOff ? offExitM : offEnterM)

        var phase: NavPhase = .navigate
        if arrived {
            phase = .arrived
        } else if isOff {
            phase = .offroute
        }

        // Pick the next waypoint strictly ahead of us along the route,
        // skipping the start marker.
        var next: NavTarget?
        var upcoming: NavTarget?
        if !arrived {
            let ahead = r.waypoints.filter { wp in
                wp.kind != WaypointKind.start.rawValue && r.cum[min(wp.i, r.cum.count - 1)] > snap.alongM + 3
            }
            if let first = ahead.first {
                next = target(route: r, pose: pose, wp: first)
            }
            if ahead.count > 1 {
                upcoming = target(route: r, pose: pose, wp: ahead[1])
            }
        }

        var offRoute: OffRouteInfo?
        if phase == .offroute {
            let rejoin = r.pointAtAlong(snap.alongM + min(20, remainM))
            let bearing = bearingDeg(from: pose.lonLat, to: rejoin.lonLat)
            offRoute = OffRouteInfo(
                distM: snap.offM,
                bearing: bearing,
                relBearing: angDiffDeg(from: pose.heading, to: bearing),
                lon: rejoin.lon,
                lat: rejoin.lat
            )
        }

        // Hiking-pace ETA: 12 min per km plus 10 min per 100 m of climb.
        let etaMin = (remainM / 1000) * 12 + (remainGainM / 100) * 10

        return NavState(
            phase: phase, snap: snap, remainM: remainM, remainGainM: remainGainM,
            etaMin: etaMin, progress: progress, next: next, upcoming: upcoming,
            offRoute: offRoute
        )
    }

    /// Human guidance strings for the HUD banner, matching the web app's
    /// navGuidance tone for tone.
    public static func guidance(for nav: NavState, routeName: String) -> Guidance {
        if nav.phase == .arrived {
            return Guidance(title: "You have arrived", sub: routeName, tone: .done)
        }
        if nav.phase == .offroute, let off = nav.offRoute {
            return Guidance(
                title: "Off trail by \(Fmt.dist(off.distM))",
                sub: "Head \(compass16(off.bearing)) to rejoin the trail",
                tone: .warn
            )
        }
        guard let next = nav.next else {
            return Guidance(title: "Follow the trail", sub: Fmt.dist(nav.remainM) + " to go", tone: .ok)
        }
        let d = next.distM
        if next.wp.isManeuver && d <= 60 {
            let title = d <= 15 ? next.wp.instruction + " now" : "\(next.wp.instruction) in \(Fmt.dist(d))"
            let sub: String
            if let upcoming = nav.upcoming {
                sub = "Then \(upcoming.wp.instruction.lowercased())"
            } else {
                sub = Fmt.dist(nav.remainM) + " to go"
            }
            return Guidance(title: title, sub: sub, tone: .action)
        }
        let label = next.wp.name ?? next.wp.instruction
        return Guidance(
            title: "\(label) in \(Fmt.dist(d))",
            sub: "\(Fmt.dist(nav.remainM)) to go",
            tone: .ok
        )
    }
}

/// Display formatting shared by the HUD and route picker, matching the web
/// app's format.ts so both clients print identical strings.
public enum Fmt {
    /// "7 m", "45 m", "1.4 km", "12 km".
    public static func dist(_ m: Double) -> String {
        guard m.isFinite else { return "--" }
        if m < 10 { return "\(Int(m.rounded())) m" }
        if m < 950 { return "\(Int((m / 5).rounded()) * 5) m" }
        let km = m / 1000
        if m < 9500 {
            return String(format: "%.1f km", km)
        }
        return "\(Int(km.rounded())) km"
    }

    /// "42 min" or "2 h 05 min".
    public static func duration(_ min: Double) -> String {
        guard min.isFinite else { return "--" }
        let m = Int(min.rounded())
        if m < 60 { return "\(m) min" }
        return String(format: "%d h %02d min", m / 60, m % 60)
    }

    /// Whole meters with no grouping, e.g. "1669 m".
    public static func ele(_ m: Double) -> String {
        "\(Int(m.rounded())) m"
    }

    /// "512 B", "218 KB", "4.8 MB".
    public static func bytes(_ b: Int) -> String {
        if b < 1024 { return "\(b) B" }
        if b < 1024 * 1024 { return "\(b / 1024) KB" }
        return String(format: "%.1f MB", Double(b) / 1024 / 1024)
    }

    /// "62%".
    public static func pct(_ p: Double) -> String {
        "\(Int((p * 100).rounded()))%"
    }
}
