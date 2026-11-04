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