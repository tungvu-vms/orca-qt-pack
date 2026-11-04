import QtQuick
import QtQuick.Controls

ApplicationWindow {
    id: window
    width: 640
    height: 480
    visible: true
    title: qsTr("Demo")

    CounterButton {
        id: counter
        anchors.centerIn: parent
        label: "Click"
        onClicked: window.title = label + " " + counter.clicks
    }
}