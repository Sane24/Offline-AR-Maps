//
//  RoutePickerView.swift
//  TrailSight
//
//  Route cards for the active region: name, blurb, stats, and a Start
//  button that begins AR navigation. Also surfaces the region header and
//  data attribution required by the pack license.
//

import SwiftUI

/// Scrollable list of route cards for one loaded region.
struct RoutePickerView: View {
    let region: RegionData
    let onStart: (RouteMeta) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header

                ForEach(region.manifest.routes) { meta in
                    RouteCard(meta: meta, onStart: { onStart(meta) })
                }

                Text(region.manifest.attribution)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(region.manifest.name)
                .font(.title2.weight(.bold))
            Text(region.manifest.blurb)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Label("Works fully offline", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(.caption.weight(.medium))
                .foregroundStyle(.green)
                .padding(.top, 2)
        }
    }
}

/// One route: stats chips and the Start button.
struct RouteCard: View {
    let meta: RouteMeta
    let onStart: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(meta.name)
                    .font(.headline)
                Text(meta.blurb)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                chip("point.topleft.down.to.point.bottomright.curvepath", Fmt.dist(meta.stats.lengthM))
                chip("arrow.up.right", "+" + Fmt.ele(meta.stats.gainM))
                chip("clock", Fmt.duration(meta.stats.estMin))
                chip("mountain.2", Fmt.ele(meta.stats.maxEle))
            }

            Button(action: onStart) {
                HStack {
                    Image(systemName: "arkit")
                    Text("Start AR navigation")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 11))
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func chip(_ symbol: String, _ text: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.medium).monospacedDigit())
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color(.tertiarySystemFill), in: Capsule())
    }
}
