// @flow

import MercatorCoordinate from '../geo/mercator_coordinate';
import DEMData from '../data/dem_data';
import SourceCache from '../source/source_cache';
import {number as interpolate} from '../style-spec/util/interpolate';
import EXTENT from '../data/extent';
import {vec3} from 'gl-matrix';

import {OverscaledTileID} from '../source/tile_id';

import type Tile from '../source/tile';

/**
 * Provides access to elevation data from raster-dem source cache.
 */
export class Elevation {

    /**
     * Altitude above sea level in meters at specified point.
     * @param {MercatorCoordinate} point Mercator coordinate of the point.
     * @param {number} defaultIfNotLoaded Value that is returned if the dem tile of the provided point is not loaded
     * @returns {number} Altitude in meters.
     * If there is no loaded tile that carries information for the requested
     * point elevation, returns `defaultIfNotLoaded`.
     * Doesn't invoke network request to fetch the data.
     */
    getAtPoint(point: MercatorCoordinate, defaultIfNotLoaded: number = 0): number {
        const src = this._source();
        if (!src) return defaultIfNotLoaded;
        if (point.y < 0.0 || point.y > 1.0) {
            return defaultIfNotLoaded;
        }
        const cache: SourceCache = src;
        const z = cache.getSource().maxzoom;
        const tiles = 1 << z;
        const wrap = Math.floor(point.x);
        const px = point.x - wrap;
        const tileID = new OverscaledTileID(z, wrap, z, Math.floor(px * tiles), Math.floor(point.y * tiles));
        const demTile = this.findDEMTileFor(tileID);
        if (!(demTile && demTile.dem)) { return defaultIfNotLoaded; }
        const dem: DEMData = demTile.dem;
        const tilesAtTileZoom = 1 << demTile.tileID.canonical.z;
        const x = (px * tilesAtTileZoom - demTile.tileID.canonical.x) * demTile.tileSize;
        const y = (point.y * tilesAtTileZoom - demTile.tileID.canonical.y) * demTile.tileSize;
        const i = Math.floor(x);
        const j = Math.floor(y);

        return this.exaggeration() * interpolate(
            interpolate(dem.get(i, j), dem.get(i, j + 1), y - j),
            interpolate(dem.get(i + 1, j), dem.get(i + 1, j + 1), y - j),
            x - i);
    }

    /*
     * x and y are offset within tile, in 0 .. EXTENT coordinate space.
     */
    getAtTileOffset(tileID: OverscaledTileID, x: number, y: number): number {
        const tilesAtTileZoom = 1 << tileID.canonical.z;
        return this.getAtPoint(new MercatorCoordinate(
            tileID.wrap + (tileID.canonical.x + x / EXTENT) / tilesAtTileZoom,
            (tileID.canonical.y + y / EXTENT) / tilesAtTileZoom));
    }

    /*
     * Batch fetch for multiple tile points: points holds input and return value:
     * vec3's items on index 0 and 1 define x and y offset within tile, in [0 .. EXTENT]
     * range, respectively. vec3 item at index 2 is output value, in meters.
     * If a DEM tile that covers tileID is loaded, true is returned, otherwise false.
     * Nearest filter sampling on dem data is done (no interpolation).
     */
    getForTilePoints(tileID: OverscaledTileID, points: Array<vec3>, interpolated: ?boolean, useDemTile: ?Tile): boolean {
        const demTile = useDemTile || this.findDEMTileFor(tileID);
        if (!(demTile && demTile.dem)) { return false; }
        const dem: DEMData = demTile.dem;
        const demTileID = demTile.tileID;
        const scale = 1 << tileID.canonical.z - demTileID.canonical.z;
        const xOffset = (tileID.canonical.x / scale - demTileID.canonical.x) * demTile.tileSize;
        const yOffset = (tileID.canonical.y / scale - demTileID.canonical.y) * demTile.tileSize;
        const k = demTile.tileSize / EXTENT / scale;

        points.forEach(p => {
            const x = p[0] * k + xOffset;
            const y = p[1] * k + yOffset;
            const i = Math.floor(x);
            const j = Math.floor(y);
            p[2] = this.exaggeration() * (interpolated ? interpolate(
                interpolate(dem.get(i, j), dem.get(i, j + 1), y - j),
                interpolate(dem.get(i + 1, j), dem.get(i + 1, j + 1), y - j),
                x - i) :
                dem.get(i, j));
        });
        return true;
    }

    /**
     * Find an intersection between the elevation surface and a line segment.
     * Uses a binary-search approach for sampling the heightmap. This function is not
     * guaranteed to return a correct result if the provided segment has multiple intersection
     * points with the terrain.
     * @param {MercatorCoordinate} start 3D mercator coordinate of the start, start.z is elevation in mercator coordinates.
     * @param {MercatorCoordinate} end 3D mercator coordinate of the end, end.z is elevation in mercator coordinates.
     * @param {number} samples How many samples to iterate.
     * @param {number} threshold When to stop enumeration.
     * @returns {MercatorCoordinate} If there is intersection with terrain, returns 3D mercator coordinate of intersection, otherwise null.
     */
    raycast(start: MercatorCoordinate, end: MercatorCoordinate, samples: number = 20, threshold: number = 0.01): ?MercatorCoordinate {
        let newCenter: ?MercatorCoordinate = null;

        for (let i = 0; i < samples; i++) {
            newCenter = new MercatorCoordinate(0.5 * (start.x + end.x), 0.5 * (start.y + end.y), 0.5 * (start.z + end.z));
            const terrainElevation = this.getAtPoint(newCenter);
            const sampleElevation = newCenter.toAltitude();
            const diff = terrainElevation - sampleElevation;

            if (Math.abs(diff) < threshold) {
                return newCenter;
            } if (diff > 0) {
                end = newCenter;
            } else {
                start = newCenter;
            }
        }

        return null;
    }

    /**
     * Given a point on screen, returns 3D MercatorCoordinate on terrain.
     * Reconstructs a picked world position by casting a ray from screen coordinates
     * and sampling depth from the custom depth buffer. This function (currently) introduces
     * a potential stall (few frames) due to it reading pixel information from the gpu.
     * Depth buffer will also be generated if it doesn't already exist.
     * @param {Point} screenPoint Screen point in pixels in top-left origin coordinate system.
     * @returns {vec3} If there is intersection with terrain, returns 3D MercatorCoordinate's of
     * intersection, as vec3(x, y, z), otherwise null.
     */ /* eslint no-unused-vars: ["error", { "args": "none" }] */
    pointCoordinate(screenPoint: Point): ?vec3 {
        throw new Error('Pure virtual method called.');
    }

    /*
     * Implementation provides SourceCache of raster-dem source type cache, in
     * order to access already loaded cached tiles.
     */
    _source(): ?SourceCache {
        throw new Error('Pure virtual method called.');
    }

    /*
     * A multiplier defined by style as terrain exaggeration. Elevation provided
     * by getXXXX methods is multiplied by this.
     */
    exaggeration(): number {
        throw new Error('Pure virtual method called.');
    }

    /**
     * Lookup DEM tile that corresponds to (covers) tileID.
     * @private
     */
    findDEMTileFor(_: OverscaledTileID): ?Tile {
        throw new Error('Pure virtual method called.');
    }
}