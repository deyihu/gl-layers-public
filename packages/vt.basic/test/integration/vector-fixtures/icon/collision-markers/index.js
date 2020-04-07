const path = require('path');
const maptalks = require('maptalks');

const marker1 = new maptalks.Marker([0, 0], {
    symbol: {
        markerFile: 'file://' + path.resolve(__dirname, '../../../resources/plane-min.png'),
        markerWidth: 30,
        markerHeight: 30,
        markerOpacity: 1
    }
});

const marker2 = new maptalks.Marker([0, 0.2], {
    symbol: {
        markerFile: 'file://' + path.resolve(__dirname, '../../../resources/plane-min.png'),
        markerWidth: 30,
        markerHeight: 30,
        markerOpacity: 1
    }
});

module.exports = {
    data: [marker1, marker2],
    options: {
        collision: true,
        debugCollision: true,
        sceneConfig: {
            fading: false
        }
    },
    view: {
        center: [0, 0],
        zoom: 6
    }
};
