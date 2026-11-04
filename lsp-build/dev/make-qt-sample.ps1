# Creates a sample Qt Quick project (C++ + QML) for testing qmlls and clangd.
# Usage: pwsh lsp-build/dev/make-qt-sample.ps1   (writes samples/qt-quick-app)
$repo = Resolve-Path "$PSScriptRoot\..\.."
$root = Join-Path $repo 'samples\qt-quick-app'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
function File($p, $t) { New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, $t) }
File "$root\CMakeLists.txt" @'
cmake_minimum_required(VERSION 3.21)
project(qtquickapp LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
find_package(Qt6 REQUIRED COMPONENTS Quick)
qt_standard_project_setup(REQUIRES 6.5)
qt_add_executable(qtquickapp main.cpp backend.cpp backend.h)
qt_add_qml_module(qtquickapp
    URI QtQuickApp
    VERSION 1.0
    QML_FILES Main.qml CounterButton.qml
)
target_link_libraries(qtquickapp PRIVATE Qt6::Quick)
'@
File "$root\backend.h" @'
#pragma once
#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

class Backend : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(int count READ count NOTIFY countChanged)
public:
    explicit Backend(QObject *parent = nullptr);
    int count() const;
    Q_INVOKABLE void increment();
    QString title() const;
signals:
    void countChanged();
private:
    int m_count = 0;
};
'@
File "$root\backend.cpp" @'
#include "backend.h"

Backend::Backend(QObject *parent) : QObject(parent) {}

int Backend::count() const { return m_count; }

void Backend::increment()
{
    ++m_count;
    emit countChanged();
}

QString Backend::title() const { return QStringLiteral("Count: %1").arg(m_count); }
'@
File "$root\main.cpp" @'
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include "backend.h"

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    Backend backend;
    backend.increment();
    QQmlApplicationEngine engine;
    engine.loadFromModule("QtQuickApp", "Main");
    return app.exec();
}
'@
File "$root\Main.qml" @'
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
'@
File "$root\CounterButton.qml" @'
import QtQuick
import QtQuick.Controls

Button {
    id: root
    property string label: "Button"
    property int clicks: 0
    text: label
    onClicked: root.clicks += 1
}
'@
"ok"
