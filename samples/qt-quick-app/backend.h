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