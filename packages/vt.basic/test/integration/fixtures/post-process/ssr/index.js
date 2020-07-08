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
                        [-0.0005, 0.0005],
                        [0.0005, 0.0005],
                        [0.0005, -0.0005],
                        [-0.0005, -0.0005],
                        [-0.0005, 0.0005]
                    ]
                ]
            },
            properties: {
                levels: 3
            }
        },
        {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-0.0004, 0.0004],
                    [0.0004, 0.0004],
                    [0.0004, -0.0004],
                    [-0.0004, -0.0004],
                    [-0.0004, 0.0004]
                ]
            },
            properties: {
                levels: 3
            }
        }
    ]
};
const plugin = {
    type: 'lit',
    dataConfig: {
        type: '3d-extrusion',
        altitudeProperty: 'levels',
        altitudeScale: 5,
        defaultAltitude: 0
    },
    sceneConfig: {
    },
};
const material = {
    'baseColorFactor': [1, 1, 1, 1],
    'roughnessFactor': 0,
    'metalnessFactor': 1,
    'outputLinear': 1
};
const style = [
    {
        renderPlugin: plugin,
        symbol: {
            polygonOpacity: 1,
            polygonFill: '#f00',
            material
        },
        filter: [
            '=',
            '$type',
            'Polygon'
        ]
    },
    {
        renderPlugin: {
            type: 'line',
            dataConfig: {
                type: 'line'
            },
            sceneConfig: {
            }
        },
        symbol: {
            lineWidth: 4,
            lineColor: '#f00'
        },
        filter: [
            '=',
            '$type',
            'LineString'
        ]
    }
];
module.exports = {
    style,
    data,
    view: {
        pitch: 70,
        center: [0, 0],
        zoom: 17
    },
    renderingCount: 1,
    sceneConfig: {
        ground: {
            enable: true,
            renderPlugin: {
                type: 'lit'
            },
            symbol: {
                ssr: true,
                polygonFill: [1, 1, 1, 1],
                polygonOpacity: 1,
                material
            }
        },
        postProcess: {
            enable: true,
            antialias: {
                enable: false
            },
            ssr: {
                enable: true
            }
        }
    }
};
