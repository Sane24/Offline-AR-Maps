//
//  HudView.swift
//  TrailSight
//
//  SwiftUI overlay drawn on top of the AR view: compass tape, guidance
//  banner, session status hints, stats row, and the route elevation
//  profile with live progress. Reads NavSessionModel, which the AR
//  coordinator updates at up to 20 Hz.
//

import SwiftUI

/// Full-screen HUD overlay for an active navigation session.
struct HudView: View {
    let route: PreparedRoute
    let session: NavSessionModel
    let location: LocationService
    let onEnd: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            CompassTapeView(heading: session.pose?.heading ?? 0)
                .frame(height: 44)
                .padding(.horizontal, 24)

            if let guidance = session.guidance {
                GuidanceBanner(guidance: guidance, nav: session.nav)
            }

            statusHints

            Spacer()

            bottomPanel
        }
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    // MARK: Status hints

    @ViewBuilder
    private var statusHints: some View {
        VStack(spacing: 6) {
            switch session.phase {
            case .initializing:
                hint("camera.viewfinder", "Starting AR session")
            case .waitingForGPS:
                hint("location.magnifyingglass", "Waiting for a GPS fix")
            case .poorAccuracy(let acc):
                hint("location.slash", "GPS accuracy \(Fmt.dist(acc)), move to open sky")
            case .relocalizing:
                hint("arrow.triangle.2.circlepath.camera", "Re-localizing, look around slowly")
            case .tracking:
                EmptyView()
            }
            if let warning = session.trackingWarning {
                hint("exclamationmark.triangle", warning)
            }
            if location.isUpdating && !location.headingIsReliable {
                hint("gyroscope", "Compass needs calibration: wave the phone in a figure eight")
            }
        }
    }

    private func hint(_ symbol: String, _ text: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.black.opacity(0.55), in: Capsule())
            .foregroundStyle(.yellow)
    }

    // MARK: Bottom panel

    private var bottomPanel: some View {
        VStack(spacing: 10) {
            if let nav = session.nav {
                HStack(spacing: 14) {
                    stat("figure.hiking", Fmt.dist(nav.remainM), "to go")
                    stat("clock", Fmt.duration(nav.etaMin), "ETA")
                    stat("arrow.up.right", Fmt.ele(nav.remainGainM), "climb left")
                    Spacer()
                    Button(action: onEnd) {
                        Text("End")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.red.opacity(0.85), in: Capsule())
                            .foregroundStyle(.white)
                    }
                }
            }

            ElevationProfileView(route: route, progress: session.nav?.progress ?? 0)
                .frame(height: 56)

            if let pose = session.pose {
                Text("GPS accuracy \(Fmt.dist(pose.accuracy))  |  \(Int(pose.ele.rounded())) m elevation")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .padding(12)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 12)
    }

    private func stat(_ symbol: String, _ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(value, systemImage: symbol)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.65))
        }
    }
}

// MARK: - Guidance banner

/// The main instruction card: maneuver symbol, title, and subtitle.
/// Off route it turns red and points toward the rejoin heading.
struct GuidanceBanner: View {
    let guidance: Guidance
    let nav: NavState?

    var body: some View {
        HStack(spacing: 12) {
            iconView
                .font(.title2.weight(.bold))
                .frame(width: 44, height: 44)
                .background(.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(guidance.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(guidance.sub)
                    .font(.subheadline)
                    .opacity(0.85)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .padding(12)
        .background(toneColor.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private var iconView: some View {
        if guidance.tone == .warn, let off = nav?.offRoute {
            // Arrow that physically points toward the rejoin heading.
            Image(systemName: "location.north.fill")
                .rotationEffect(.degrees(off.relBearing))
        } else {
            Image(systemName: symbolName)
        }
    }

    private var symbolName: String {
        switch guidance.tone {
        case .done:
            return "flag.checkered"
        case .warn:
            return "exclamationmark.triangle.fill"
        case .ok, .action:
            guard let wp = nav?.next?.wp else { return "figure.hiking" }
            return GuidanceBanner.symbol(for: wp)
        }
    }

    /// SF Symbol for a waypoint's maneuver or landmark kind.
    static func symbol(for wp: Waypoint) -> String {
        let left = wp.dir == "left"
        switch wp.kindValue {
        case .bear, .turn:
            return left ? "arrow.turn.up.left" : "arrow.turn.up.right"
        case .switchback:
            return left ? "arrow.uturn.left" : "arrow.uturn.right"
        case .arrive:
            return "flag.checkered"
        case .peak:
            return "mountain.2.fill"
        case .saddle:
            return "mountain.2"
        case .viewpoint:
            return "binoculars.fill"
        case .water:
            return "drop.fill"
        case .landmark:
            return "mappin.and.ellipse"
        case .guidepost:
            return "signpost.right.fill"
        case .start, .none:
            return "arrow.up"
        }
    }

    private var toneColor: Color {
        switch guidance.tone {
        case .ok:
            return Color(red: 0.09, green: 0.32, blue: 0.55)
        case .action:
            return Color(red: 0.05, green: 0.45, blue: 0.30)
        case .warn:
            return Color(red: 0.72, green: 0.12, blue: 0.12)
        case .done:
            return Color(red: 0.16, green: 0.42, blue: 0.16)
        }
    }
}

// MARK: - Compass tape

/// Sliding compass strip: ticks every 5 degrees, wind labels every 45,
/// covering 100 degrees of view centered on the current heading.
struct CompassTapeView: View {
    let heading: Double

    private static let windNames = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

    var body: some View {
        Canvas { context, size in
            let halfSpan = 50.0
            let pxPerDeg = size.width / (halfSpan * 2)
            let start = heading - halfSpan

            // Background strip.
            let bg = Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 10)
            context.fill(bg, with: .color(.black.opacity(0.45)))

            let firstTick = (start / 5).rounded(.down) * 5
            var tick = firstTick
            while tick <= heading + halfSpan {
                let x = (tick - start) * pxPerDeg
                if x >= 4 && x <= size.width - 4 {
                    let norm = wrap360(tick)
                    let isMajor = norm.truncatingRemainder(dividingBy: 15) == 0
                    let isWind = norm.truncatingRemainder(dividingBy: 45) == 0
                    let tickHeight: CGFloat = isWind ? 12 : (isMajor ? 9 : 5)
                    var line = Path()
                    line.move(to: CGPoint(x: x, y: size.height - 6))
                    line.addLine(to: CGPoint(x: x, y: size.height - 6 - tickHeight))
                    context.stroke(
                        line,
                        with: .color(.white.opacity(isWind ? 0.95 : 0.55)),
                        lineWidth: isWind ? 2 : 1
                    )
                    if isWind {
                        let idx = Int(norm / 45) % 8
                        context.draw(
                            Text(CompassTapeView.windNames[idx])
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white),
                            at: CGPoint(x: x, y: 11)
                        )
                    }
                }
                tick += 5
            }

            // Center caret.
            let cx = size.width / 2
            var caret = Path()
            caret.move(to: CGPoint(x: cx - 6, y: 0))
            caret.addLine(to: CGPoint(x: cx + 6, y: 0))
            caret.addLine(to: CGPoint(x: cx, y: 8))
            caret.closeSubpath()
            context.fill(caret, with: .color(.orange))
        }
    }
}

// MARK: - Elevation profile

/// Route elevation profile with a marker at the current progress. Pure
/// Path drawing, downsampled so the path stays light.
struct ElevationProfileView: View {
    let route: PreparedRoute
    /// 0..1 along the route.
    let progress: Double

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let stats = route.stats
            let span = max(stats.maxEle - stats.minEle, 1)
            let total = max(route.lengthM, 1)
            let n = route.coords.count
            let step = max(1, n / 160)

            let points: [CGPoint] = stride(from: 0, to: n, by: step).map { i in
                CGPoint(
                    x: route.cum[i] / total * w,
                    y: h - (route.data.ele(at: i) - stats.minEle) / span * (h - 8) - 4
                )
            }

            ZStack {
                if points.count > 1 {
                    // Filled area under the profile.
                    Path { p in
                        p.move(to: CGPoint(x: points[0].x, y: h))
                        for pt in points { p.addLine(to: pt) }
                        if let last = points.last {
                            p.addLine(to: CGPoint(x: last.x, y: h))
                        }
                        p.closeSubpath()
                    }
                    .fill(Color.cyan.opacity(0.18))

                    // Profile line.
                    Path { p in
                        p.move(to: points[0])
                        for pt in points.dropFirst() { p.addLine(to: pt) }
                    }
                    .stroke(Color.cyan.opacity(0.9), lineWidth: 1.5)

                    // Progress marker.
                    let alongM = progress * route.lengthM
                    let sample = route.pointAtAlong(alongM)
                    let mx = alongM / total * w
                    let my = h - (sample.ele - stats.minEle) / span * (h - 8) - 4
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 9, height: 9)
                        .position(x: mx, y: my)
                }
            }
        }
    }
}
