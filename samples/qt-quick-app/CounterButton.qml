import QtQuick
import QtQuick.Controls

Button {
    id: root
    property string label: "Button"
    property int clicks: 0
    text: label
    onClicked: root.clicks += 1
}