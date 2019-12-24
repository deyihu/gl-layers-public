const data = {
    type: 'FeatureCollection',
    features: [
        // { type : 'Feature', geometry : { type : 'Polygon', coordinates : [[[-1, 0.0], [-0.4, 0.0], [0, -0.5], [-1, 0]]] }, properties : { type : 3 }}
        {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [-1., 1.0],
                        [1., 1.0],
                        [1., -1.0],
                        [-1., -1],
                        [-1., 1]
                    ],
                    [
                        [-0.5, 0.5],
                        [0.5, 0.5],
                        [0.5, -0.5],
                        [-0.5, -0.5],
                        [-0.5, 0.5]
                    ]
                ]
            },
            properties: {
                levels: 3000
            }
        }
    ]
};
var plugin = {
    type: 'lit',
    dataConfig: {
        type: '3d-extrusion',
        altitudeProperty: 'levels',
        altitudeScale: 5,
        defaultAltitude: 0
    },
    sceneConfig: {
        lights: {
            ambient: {
                color: [0.1, 0.1, 0.1]
            },
            directional: {
                color: [0.1, 0.1, 0.1],
                direction: [1, 0, -1],
            }
        }
    },
};
const material = {
    'baseColorFactor': [1, 1, 1, 1],
    'roughnessFactor': 0,
    'metalnessFactor': 1,
    'outputLinear': 1
};
var style = [{
    renderPlugin: plugin,
    symbol: {
        polygonOpacity: 1,
        polygonFill: '#f00',
        material
    },
    filter: true,
}];
module.exports = {
    style,
    data: data,
    view: {
        pitch: 80,
        center: [0, 0],
        zoom: 6
    }
};
