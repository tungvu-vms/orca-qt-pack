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