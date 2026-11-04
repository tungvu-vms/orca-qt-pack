# Sample qmake project
QT += core gui widgets qml
CONFIG += c++17 warn_on
TEMPLATE = app
TARGET = demo
SOURCES += main.cpp \
           mainwindow.cpp
HEADERS += mainwindow.h
FORMS += mainwindow.ui
RESOURCES += app.qrc
win32:CONFIG(release, debug|release): DEFINES += APP_RELEASE
unix {
    LIBS += -L$$PWD/lib -lfoo
    message("Building on $$[QT_VERSION]")
}
